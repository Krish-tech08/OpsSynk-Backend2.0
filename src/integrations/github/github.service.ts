import type { GitHubTransport } from "./github.client.js";
import type {
  CommitItem, DeploymentItem, IssueItem, PullRequestItem, ReleaseItem, RepoSummary, RepositorySignals, Signal, WorkflowRunItem,
} from "./github.types.js";
import { Errors, isAppError } from "../../utils/errors.js";
import { DAY_MS } from "../../utils/time.js";

/* ---------- normalization (pure, unit tested) ---------- */

export const normalizeRepo = (r: any): RepoSummary => ({
  id: r.name, fullName: r.full_name, owner: r.owner?.login ?? r.full_name.split("/")[0], url: r.html_url,
  description: r.description ?? null, defaultBranch: r.default_branch ?? "main",
  private: Boolean(r.private), archived: Boolean(r.archived), pushedAt: r.pushed_at ?? null,
});

/**
 * GitHub's issues endpoint returns pull requests too (items with a `pull_request` key).
 * They are separated here so issue and bug counts never include PRs.
 */
export function separateIssuesAndPullRequests(items: any[]): { issues: IssueItem[]; pullRequestsExcluded: number } {
  const issues: IssueItem[] = [];
  let pullRequestsExcluded = 0;
  for (const i of items) {
    if (i.pull_request) { pullRequestsExcluded++; continue; }
    issues.push({
      number: i.number, title: i.title, state: i.state,
      labels: (i.labels ?? []).map((l: any) => (typeof l === "string" ? l : l.name)).filter(Boolean),
      createdAt: i.created_at, updatedAt: i.updated_at, closedAt: i.closed_at ?? null, url: i.html_url,
      author: i.user?.login ?? null, assignees: (i.assignees ?? []).map((a: any) => a.login),
    });
  }
  return { issues, pullRequestsExcluded };
}

export const normalizePull = (p: any): PullRequestItem => ({
  number: p.number, title: p.title, draft: Boolean(p.draft), createdAt: p.created_at, updatedAt: p.updated_at,
  url: p.html_url, author: p.user?.login ?? null, requestedReviewers: (p.requested_reviewers ?? []).length,
  baseBranch: p.base?.ref ?? "",
});

export const normalizeCommit = (c: any): CommitItem => ({
  sha: c.sha, message: String(c.commit?.message ?? "").split("\n")[0].slice(0, 120),
  author: c.author?.login ?? c.commit?.author?.name ?? null,
  committedAt: c.commit?.committer?.date ?? c.commit?.author?.date, url: c.html_url,
});

export const normalizeRun = (r: any): WorkflowRunItem => ({
  id: r.id, name: r.name ?? r.display_title ?? "workflow", event: r.event, status: r.status, conclusion: r.conclusion ?? null,
  headBranch: r.head_branch ?? null, createdAt: r.created_at, updatedAt: r.updated_at, url: r.html_url, runAttempt: r.run_attempt ?? 1,
});

export const normalizeRelease = (r: any): ReleaseItem => ({
  id: r.id, tagName: r.tag_name, name: r.name ?? null, publishedAt: r.published_at ?? null, url: r.html_url,
  draft: Boolean(r.draft), prerelease: Boolean(r.prerelease),
});

/* ---------- service ---------- */

export interface GitHubServiceOptions {
  allowlist: string[];
  activityWindowDays: number;
  ciWindowDays: number;
  now: () => Date;
  maxDeploymentsWithStatus?: number;
  /** Base for human-facing links: https://github.com for live data, a reserved .invalid host for fixtures. */
  htmlBaseUrl: string;
}

const toSignal = async <T>(fn: () => Promise<{ value: T; truncated: boolean }>): Promise<Signal<T>> => {
  try {
    const r = await fn();
    return { ok: true, value: r.value, truncated: r.truncated };
  } catch (e) {
    return { ok: false, error: isAppError(e) ? e.message : "Unexpected error while reading GitHub.", code: isAppError(e) ? e.code : "UNKNOWN" };
  }
};

export class GitHubService {
  constructor(private readonly t: GitHubTransport, private readonly o: GitHubServiceOptions) {}

  get source() { return this.t.source; }
  rateLimit() { return this.t.rateLimit(); }

  /** Repositories in the organization, restricted to the allowlist when one is configured. */
  async listRepositories(org: string): Promise<{ repositories: RepoSummary[]; truncated: boolean }> {
    const page = await this.t.getPaginated<any>(`/orgs/${encodeURIComponent(org)}/repos`, { type: "all", sort: "full_name" });
    let repositories = page.items.map(normalizeRepo);
    if (this.o.allowlist.length) repositories = repositories.filter((r) => this.o.allowlist.includes(r.id));
    return { repositories, truncated: page.truncated };
  }

  async getRepository(org: string, repo: string): Promise<RepoSummary> {
    if (this.o.allowlist.length && !this.o.allowlist.includes(repo)) throw Errors.notFound("Repository");
    return normalizeRepo(await this.t.getJson(`/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`));
  }

  private base(org: string, repo: string) { return `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`; }
  private since(days: number) { return new Date(this.o.now().getTime() - days * DAY_MS).toISOString(); }

  async listOpenIssues(org: string, repo: string) {
    const page = await this.t.getPaginated<any>(`${this.base(org, repo)}/issues`, { state: "open" });
    const { issues, pullRequestsExcluded } = separateIssuesAndPullRequests(page.items);
    return { value: issues, truncated: page.truncated, pullRequestsExcluded };
  }

  async listOpenPullRequests(org: string, repo: string) {
    const page = await this.t.getPaginated<any>(`${this.base(org, repo)}/pulls`, { state: "open" });
    return { value: page.items.map(normalizePull), truncated: page.truncated };
  }

  async listRecentCommits(org: string, repo: string, branch: string, days = this.o.activityWindowDays) {
    const page = await this.t.getPaginated<any>(`${this.base(org, repo)}/commits`, { sha: branch, since: this.since(days) });
    return { value: page.items.map(normalizeCommit), truncated: page.truncated };
  }

  async listWorkflowRuns(org: string, repo: string, days = this.o.ciWindowDays) {
    const date = this.since(days).slice(0, 10);
    const page = await this.t.getPaginated<any>(`${this.base(org, repo)}/actions/runs`, { created: `>=${date}` }, "workflow_runs");
    return { value: page.items.map(normalizeRun), truncated: page.truncated };
  }

  async listReleases(org: string, repo: string) {
    const items = await this.t.getJson<any[]>(`${this.base(org, repo)}/releases`, { per_page: 10 });
    return { value: items.map(normalizeRelease), truncated: false };
  }

  /**
   * Deployment evidence comes only from GitHub's Deployments API (deployments + their statuses).
   * Workflow names or releases are never treated as proof that something was deployed.
   */
  async listDeployments(org: string, repo: string) {
    const raw = await this.t.getJson<any[]>(`${this.base(org, repo)}/deployments`, { per_page: 10 });
    const limit = this.o.maxDeploymentsWithStatus ?? 5;
    const value: DeploymentItem[] = [];
    for (const d of raw.slice(0, limit)) {
      const statuses = await this.t.getJson<any[]>(`${this.base(org, repo)}/deployments/${d.id}/statuses`, { per_page: 1 });
      const s = statuses[0];
      value.push({
        id: d.id, environment: d.environment, ref: d.ref, createdAt: d.created_at,
        url: `${this.o.htmlBaseUrl}/${org}/${repo}/deployments`,
        latestStatus: s ? { state: s.state, createdAt: s.created_at, environmentUrl: s.environment_url || null, logUrl: s.log_url || null } : null,
      });
    }
    return { value, truncated: raw.length > limit };
  }

  /** Everything the health engine and agents need for one repository, with per-signal failure capture. */
  async getRepositorySignals(org: string, repository: RepoSummary): Promise<RepositorySignals> {
    const r = repository.id;
    const [issues, pullRequests, commits, workflowRuns, releases, deployments] = await Promise.all([
      toSignal(() => this.listOpenIssues(org, r)),
      toSignal(() => this.listOpenPullRequests(org, r)),
      toSignal(() => this.listRecentCommits(org, r, repository.defaultBranch)),
      toSignal(() => this.listWorkflowRuns(org, r)),
      toSignal(() => this.listReleases(org, r)),
      toSignal(() => this.listDeployments(org, r)),
    ]);
    return { repository, source: this.t.source, fetchedAt: this.o.now().toISOString(), issues, pullRequests, commits, workflowRuns, releases, deployments };
  }
}
