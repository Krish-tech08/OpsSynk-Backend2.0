import { z, type ZodType } from "zod";
import type { Store } from "../../repositories/store.js";
import type { GitHubService } from "../../integrations/github/github.service.js";
import type { HealthService } from "../../services/health.service.js";
import type { RepoSummary, RepositorySignals } from "../../integrations/github/github.types.js";
import type { Organization, Project, Task, Incident } from "../../types/domain.js";
import type { ProjectHealth, CompanyHealth } from "../../domain/health/health.types.js";
import type { AgentId, InvestigationEventType } from "../../types/investigation.js";
import { EvidenceLedger } from "./evidence-ledger.js";
import { AppError, Errors, isAppError } from "../../utils/errors.js";
import { daysBetween } from "../../utils/time.js";

export interface ToolContext {
  organization: Organization;
  scope: { projectIds: string[]; repositoryIds: string[] };
  store: Store;
  github: GitHubService;
  health: HealthService;
  ledger: EvidenceLedger;
  now: () => Date;
}

interface ToolDef<I, O> {
  name: string; input: ZodType<I>;
  run(input: I, ctx: ToolContext, memo: Map<string, unknown>): Promise<O>;
  summarize(o: O): Record<string, number>;
  /** Results with a memo key are shared within one investigation; cache hits do no I/O and are not charged. */
  memoKey?: (input: I) => string;
}

const RepoId = z.object({ repositoryId: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/) });
const ProjectId = z.object({ projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });

/** Projects in scope: explicit scope, else every active project of the organization. */
async function scopedProjects(ctx: ToolContext): Promise<Project[]> {
  const all = await ctx.store.projects.list(ctx.organization.id);
  const live = all.filter((p) => !["completed", "cancelled"].includes(p.status));
  return ctx.scope.projectIds.length ? all.filter((p) => ctx.scope.projectIds.includes(p.id)) : live;
}

/** Records evidence for every item in a repository's signals. */
function recordSignals(ledger: EvidenceLedger, s: RepositorySignals) {
  const repo = s.repository.id;
  const observedAt = s.fetchedAt;
  if (s.pullRequests.ok) for (const p of s.pullRequests.value)
    ledger.record({ sourceType: "github", sourceId: `pr:${repo}#${p.number}`, sourceUrl: p.url, observedAt,
      details: { repository: repo, number: p.number, title: p.title, updatedAt: p.updatedAt, draft: p.draft } });
  if (s.issues.ok) for (const i of s.issues.value)
    ledger.record({ sourceType: "github", sourceId: `issue:${repo}#${i.number}`, sourceUrl: i.url, observedAt,
      details: { repository: repo, number: i.number, title: i.title, labels: i.labels } });
  if (s.workflowRuns.ok) for (const r of s.workflowRuns.value)
    ledger.record({ sourceType: "github", sourceId: `run:${repo}#${r.id}`, sourceUrl: r.url, observedAt,
      details: { repository: repo, workflow: r.name, conclusion: r.conclusion, branch: r.headBranch, createdAt: r.createdAt } });
  if (s.deployments.ok) for (const d of s.deployments.value)
    ledger.record({ sourceType: "github", sourceId: `deployment:${repo}#${d.id}`, sourceUrl: d.url, observedAt,
      details: { repository: repo, environment: d.environment, state: d.latestStatus?.state ?? null, createdAt: d.createdAt } });
  if (s.commits.ok) {
    const latest = s.commits.value.map((c) => c.committedAt).sort().at(-1) ?? null;
    ledger.record({ sourceType: "github", sourceId: `activity:${repo}`, sourceUrl: s.repository.url, observedAt,
      details: { repository: repo, commitsInWindow: s.commits.value.length, lastCommitAt: latest, pushedAt: s.repository.pushedAt } });
  }
}

export const TOOLS = {
  listRepositories: {
    name: "listRepositories", input: z.object({}).strict(),
    /** Repositories in scope: explicit scope ∪ repositories mapped to scoped projects, restricted to the org. */
    async run(_i, ctx, memo) {
      if (memo.has("repos")) return memo.get("repos") as { repositories: RepoSummary[]; unmapped: string[] };
      const available = await ctx.health.orgRepositories(ctx.organization);
      const wanted = new Set([...ctx.scope.repositoryIds, ...(await scopedProjects(ctx)).flatMap((p) => p.repositoryIds)]);
      const repositories = available.filter((r) => wanted.has(r.id));
      const unmapped = [...wanted].filter((id) => !available.some((r) => r.id === id));
      const out = { repositories, unmapped };
      memo.set("repos", out);
      return out;
    },
    summarize: (o) => ({ repositoryCount: o.repositories.length, unavailableRepositories: o.unmapped.length }),
    memoKey: () => "repos",
  } as ToolDef<Record<string, never>, { repositories: RepoSummary[]; unmapped: string[] }>,

  getRepositorySignals: {
    name: "getRepositorySignals", input: RepoId,
    async run({ repositoryId }, ctx, memo) {
      const key = `signals:${repositoryId}`;
      if (memo.has(key)) return memo.get(key) as RepositorySignals;
      const { repositories } = await TOOLS.listRepositories.run({}, ctx, memo);
      const repo = repositories.find((r) => r.id === repositoryId);
      if (!repo) throw Errors.notFound("Repository in investigation scope");
      const s = await ctx.github.getRepositorySignals(ctx.organization.githubOrganization, repo);
      recordSignals(ctx.ledger, s);
      memo.set(key, s);
      return s;
    },
    memoKey: ({ repositoryId }) => `signals:${repositoryId}`,
    summarize: (s) => ({
      pullRequests: s.pullRequests.ok ? s.pullRequests.value.length : -1,
      issues: s.issues.ok ? s.issues.value.length : -1,
      workflowRuns: s.workflowRuns.ok ? s.workflowRuns.value.length : -1,
      unavailableSignals: [s.issues, s.pullRequests, s.commits, s.workflowRuns, s.deployments].filter((x) => !x.ok).length,
    }),
  } as ToolDef<z.infer<typeof RepoId>, RepositorySignals>,

  listProjects: {
    name: "listProjects", input: z.object({}).strict(),
    async run(_i, ctx) {
      const projects = await scopedProjects(ctx);
      for (const p of projects) ctx.ledger.record({ sourceType: "firestore", sourceId: `project:${p.id}`,
        details: { name: p.name, status: p.status, ownerUid: p.ownerUid, dueDate: p.dueDate, repositoryIds: p.repositoryIds } });
      return projects;
    },
    summarize: (o) => ({ projectCount: o.length }),
  } as ToolDef<Record<string, never>, Project[]>,

  getProjectTasks: {
    name: "getProjectTasks", input: ProjectId,
    async run({ projectId }, ctx) {
      const p = await ctx.store.projects.get(projectId);
      if (!p || p.organizationId !== ctx.organization.id) throw Errors.notFound("Project");
      const tasks = await ctx.store.tasks.listByProject(projectId);
      const now = ctx.now();
      for (const t of tasks) ctx.ledger.record({ sourceType: "firestore", sourceId: `task:${t.id}`,
        details: { projectId, title: t.title, status: t.status, dueDate: t.dueDate, assigneeUid: t.assigneeUid,
          overdue: t.status !== "done" && !!t.dueDate && new Date(t.dueDate) < now } });
      return tasks;
    },
    summarize: (o) => ({ taskCount: o.length }),
  } as ToolDef<z.infer<typeof ProjectId>, Task[]>,

  calculateProjectHealth: {
    name: "calculateProjectHealth", input: ProjectId,
    async run({ projectId }, ctx) {
      const p = await ctx.store.projects.get(projectId);
      if (!p || p.organizationId !== ctx.organization.id) throw Errors.notFound("Project");
      const h = await ctx.health.projectHealth(p);
      ctx.ledger.record({ sourceType: "metrics", sourceId: `project-health:${projectId}`,
        details: { score: h.score, status: h.status, coverage: h.coverage, missingSignals: h.missingSignals,
          subScores: Object.fromEntries(h.subScores.map((s) => [s.category, s.score])) } });
      return h;
    },
    summarize: (h) => ({ score: h.score ?? -1, coverage: h.coverage }),
  } as ToolDef<z.infer<typeof ProjectId>, ProjectHealth>,

  calculateCompanyHealth: {
    name: "calculateCompanyHealth", input: z.object({}).strict(),
    async run(_i, ctx) {
      const { company } = await ctx.health.companyHealth(ctx.organization.id, ctx.scope.projectIds);
      ctx.ledger.record({ sourceType: "metrics", sourceId: `company-health:${ctx.organization.id}`,
        details: { score: company.score, status: company.status, coverage: company.coverage, projectCounts: company.projectCounts } });
      return company;
    },
    summarize: (c) => ({ score: c.score ?? -1, projects: c.projects.length }),
  } as ToolDef<Record<string, never>, CompanyHealth>,

  getIncidentDetails: {
    name: "getIncidentDetails", input: z.object({ incidentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }),
    async run({ incidentId }, ctx) {
      const i = await ctx.store.incidents.get(incidentId);
      if (!i || i.organizationId !== ctx.organization.id) throw Errors.notFound("Incident");
      ctx.ledger.record({ sourceType: "firestore", sourceId: `incident:${i.id}`,
        details: { title: i.title, severity: i.severity, status: i.status, projectId: i.projectId, ageDays: Math.floor(daysBetween(i.createdAt, ctx.now())) } });
      return i;
    },
    summarize: () => ({ incidents: 1 }),
  } as ToolDef<{ incidentId: string }, Incident>,
};
export type ToolName = keyof typeof TOOLS;
type ToolIO<N extends ToolName> = (typeof TOOLS)[N] extends ToolDef<infer I, infer O> ? { in: I; out: O } : never;

/** Only the tools relevant to each agent are available to it. */
export const AGENT_TOOLS: Record<AgentId, ToolName[]> = {
  manager: ["calculateCompanyHealth", "getIncidentDetails"],
  github: ["listRepositories", "getRepositorySignals"],
  project: ["listProjects", "getProjectTasks", "calculateProjectHealth"],
  bug: ["listRepositories", "getRepositorySignals"],
  devops: ["listRepositories", "getRepositorySignals"],
  review: [],
};

export type Emit = (e: { agentId: AgentId | null; eventType: InvestigationEventType; message: string; status: "started" | "completed" | "failed" | "info"; metadata?: Record<string, string | number | boolean | null> }) => Promise<void>;

/** Validates, authorizes (per agent), budgets, times out and reports every tool call. */
export class ToolRunner {
  private calls = 0;
  private readonly memo = new Map<string, unknown>();
  constructor(private readonly ctx: ToolContext, private readonly maxCalls: number, private readonly emit: Emit, private readonly timeoutMs = 30_000) {}

  get used() { return this.calls; }
  get ledger() { return this.ctx.ledger; }

  async call<N extends ToolName>(agentId: AgentId, name: N, input: ToolIO<N>["in"]): Promise<ToolIO<N>["out"]> {
    if (!AGENT_TOOLS[agentId].includes(name)) throw new AppError("TOOL_NOT_PERMITTED", `Agent ${agentId} may not use ${name}.`, 403);
    const tool = TOOLS[name] as unknown as ToolDef<ToolIO<N>["in"], ToolIO<N>["out"]>;
    const parsed = tool.input.safeParse(input);
    if (!parsed.success) throw new AppError("INVALID_TOOL_INPUT", `Invalid input for ${name}.`, 400, parsed.error.issues);
    const key = tool.memoKey?.(parsed.data);
    if (key && this.memo.has(key)) {
      await this.emit({ agentId, eventType: "tool.completed", message: `${name} completed (shared result)`, status: "completed", metadata: { tool: name, cached: true } });
      return this.memo.get(key) as ToolIO<N>["out"];
    }
    if (this.calls >= this.maxCalls) throw Errors.toolBudgetExceeded(this.maxCalls);
    this.calls++;
    await this.emit({ agentId, eventType: "tool.started", message: `${name} started`, status: "started", metadata: { tool: name } });
    let timer: NodeJS.Timeout | undefined;
    try {
      const out = await Promise.race([
        tool.run(parsed.data, this.ctx, this.memo),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(Errors.timeout(`Tool ${name}`)), this.timeoutMs); }),
      ]);
      await this.emit({ agentId, eventType: "tool.completed", message: `${name} completed`, status: "completed", metadata: { tool: name, ...tool.summarize(out) } });
      return out;
    } catch (e) {
      await this.emit({ agentId, eventType: "tool.failed", message: `${name} failed`, status: "failed",
        metadata: { tool: name, code: isAppError(e) ? e.code : "UNKNOWN" } });
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
