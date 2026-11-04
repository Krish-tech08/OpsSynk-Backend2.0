import type { Store } from "../repositories/store.js";
import type { GitHubService } from "../integrations/github/github.service.js";
import type { RepoSummary, RepositorySignals } from "../integrations/github/github.types.js";
import type { HealthConfig } from "../domain/health/health.config.js";
import type { CompanyHealth, ProjectHealth } from "../domain/health/health.types.js";
import { computeCompanyHealth, computeProjectHealth } from "../domain/health/project-health.js";
import type { Organization, Project } from "../types/domain.js";
import { Errors, isAppError } from "../utils/errors.js";

const EXCLUDED_STATUSES = new Set(["completed", "cancelled"]);

export class HealthService {
  constructor(
    private readonly store: Store,
    private readonly github: GitHubService,
    private readonly cfg: HealthConfig,
    private readonly now: () => Date,
  ) {}

  get config() { return this.cfg; }

  async organization(orgId: string): Promise<Organization> {
    const org = await this.store.organizations.get(orgId);
    if (!org) throw Errors.notFound("Organization");
    return org;
  }

  /** Repositories in the org (cached by the client). Failure → GitHub error surfaced to the caller. */
  async orgRepositories(org: Organization): Promise<RepoSummary[]> {
    return (await this.github.listRepositories(org.githubOrganization)).repositories;
  }

  /** Fetch signals for mapped repositories. Unreachable repositories are reported, not dropped silently. */
  async signalsFor(org: Organization, repoIds: string[]): Promise<{ signals: RepositorySignals[]; unreachable: string[] }> {
    let available: RepoSummary[];
    try { available = await this.orgRepositories(org); }
    catch (e) { if (isAppError(e)) return { signals: [], unreachable: repoIds }; throw e; }
    const byId = new Map(available.map((r) => [r.id, r]));
    const unreachable = repoIds.filter((id) => !byId.has(id));
    const signals = await Promise.all(repoIds.filter((id) => byId.has(id)).map((id) => this.github.getRepositorySignals(org.githubOrganization, byId.get(id)!)));
    return { signals, unreachable };
  }

  async projectHealth(project: Project): Promise<ProjectHealth> {
    const org = await this.organization(project.organizationId);
    const [tasks, { signals, unreachable }] = await Promise.all([
      this.store.tasks.listByProject(project.id),
      this.signalsFor(org, project.repositoryIds),
    ]);
    return computeProjectHealth(project, tasks, signals, this.cfg, this.now(), unreachable);
  }

  async companyHealth(orgId: string, projectIds?: string[]): Promise<{ company: CompanyHealth; projects: ProjectHealth[] }> {
    let projects = await this.store.projects.list(orgId);
    if (projectIds?.length) projects = projects.filter((p) => projectIds.includes(p.id));
    const excluded = projects.filter((p) => EXCLUDED_STATUSES.has(p.status)).map((p) => ({ projectId: p.id, reason: `Project status is ${p.status}.` }));
    const included = projects.filter((p) => !EXCLUDED_STATUSES.has(p.status));
    const healths = await Promise.all(included.map((p) => this.projectHealth(p)));
    return { company: computeCompanyHealth(orgId, healths, excluded, this.cfg, this.now()), projects: healths };
  }
}
