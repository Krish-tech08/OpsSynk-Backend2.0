import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { parse } from "../middleware/validation.middleware.js";
import { rateLimit } from "../middleware/rate-limit.middleware.js";
import { OrgQuery } from "../schemas/common.schemas.js";
import { requireOrgRole } from "../services/authorization.service.js";
import { ciStats, prStats, bugStats, activityStats } from "../domain/health/metrics.js";
import type { EngineeringSnapshot } from "../types/domain.js";
import { Errors } from "../utils/errors.js";
import { ok } from "./respond.js";

const RepoParam = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, "invalid repository name");

export function githubRoutes(ctx: AppContext) {
  const r = Router();
  const cfg = () => ctx.health.config;

  /** Authorize, load the org and make sure the repository belongs to it (and the allowlist). */
  async function scope(req: any, minRole: "viewer" | "member" = "viewer") {
    const { organizationId } = parse(OrgQuery, req.query);
    await requireOrgRole(ctx.store, req.user!.uid, organizationId, minRole);
    return ctx.health.organization(organizationId);
  }
  async function repoIn(req: any) {
    const org = await scope(req);
    const name = parse(RepoParam, req.params.repositoryId);
    const repo = (await ctx.health.orgRepositories(org)).find((x) => x.id === name);
    if (!repo) throw Errors.notFound("Repository");
    return { org, repo };
  }
  const meta = () => ({ dataSource: ctx.github.source, isDemoData: ctx.github.source === "fixture", fetchedAt: ctx.now().toISOString() });

  r.get("/repositories", async (req, res) => {
    const org = await scope(req);
    const { repositories, truncated } = await ctx.github.listRepositories(org.githubOrganization);
    ok(res, repositories, { ...meta(), truncated });
  });
  r.get("/repositories/:repositoryId", async (req, res) => {
    const { org, repo } = await repoIn(req);
    const s = await ctx.github.getRepositorySignals(org.githubOrganization, repo);
    const now = ctx.now();
    ok(res, {
      repository: repo,
      summary: {
        openIssues: s.issues.ok ? s.issues.value.length : null,
        openBugs: s.issues.ok ? bugStats(s.issues.value, cfg()).total : null,
        openPullRequests: s.pullRequests.ok ? prStats(s.pullRequests.value, now, cfg().windows.stalePrDays).open : null,
        stalePullRequests: s.pullRequests.ok ? prStats(s.pullRequests.value, now, cfg().windows.stalePrDays).stale : null,
        ci: s.workflowRuns.ok ? ciStats(s.workflowRuns.value, repo.defaultBranch, cfg()) : null,
        activity: s.commits.ok ? activityStats(s.commits.value, repo.pushedAt, now) : null,
        deployments: s.deployments.ok
          ? (s.deployments.value.length ? s.deployments.value : "no_deployment_data")
          : "unavailable",
      },
      unavailableSignals: Object.entries({ issues: s.issues, pullRequests: s.pullRequests, commits: s.commits, workflowRuns: s.workflowRuns, deployments: s.deployments })
        .filter(([, v]) => !v.ok).map(([k]) => k),
    }, meta());
  });
  r.get("/repositories/:repositoryId/issues", async (req, res) => {
    const { org, repo } = await repoIn(req);
    const r2 = await ctx.github.listOpenIssues(org.githubOrganization, repo.id);
    ok(res, r2.value, { ...meta(), truncated: r2.truncated, pullRequestsExcluded: r2.pullRequestsExcluded });
  });
  r.get("/repositories/:repositoryId/pulls", async (req, res) => {
    const { org, repo } = await repoIn(req);
    const r2 = await ctx.github.listOpenPullRequests(org.githubOrganization, repo.id);
    const now = ctx.now();
    const staleDays = cfg().windows.stalePrDays;
    ok(res, r2.value.map((p) => ({ ...p, stale: prStats([p], now, staleDays).stale === 1 })), { ...meta(), truncated: r2.truncated, staleThresholdDays: staleDays });
  });
  r.get("/repositories/:repositoryId/workflows", async (req, res) => {
    const { org, repo } = await repoIn(req);
    const r2 = await ctx.github.listWorkflowRuns(org.githubOrganization, repo.id);
    ok(res, { runs: r2.value, stats: ciStats(r2.value, repo.defaultBranch, cfg()) }, { ...meta(), truncated: r2.truncated, windowDays: cfg().windows.ciDays });
  });

  /** Captures one snapshot per mapped repository per hour (deterministic IDs → safe to retry). */
  r.post("/sync", rateLimit("sync", ctx.env.SYNC_RATE_LIMIT, ctx.env.RATE_LIMIT_WINDOW_MS), async (req, res) => {
    const { organizationId } = parse(OrgQuery, { ...req.query, ...(req.body ?? {}) });
    await requireOrgRole(ctx.store, req.user!.uid, organizationId, "member");
    const org = await ctx.health.organization(organizationId);
    const repoIds = [...new Set((await ctx.store.projects.list(organizationId)).flatMap((p) => p.repositoryIds))];
    const { signals, unreachable } = await ctx.health.signalsFor(org, repoIds);
    const now = ctx.now();
    const hour = now.toISOString().slice(0, 13).replace(/[-T:]/g, "");
    const written: string[] = [];
    for (const s of signals) {
      const ci = s.workflowRuns.ok ? ciStats(s.workflowRuns.value, s.repository.defaultBranch, cfg()) : null;
      const pr = s.pullRequests.ok ? prStats(s.pullRequests.value, now, cfg().windows.stalePrDays) : null;
      const act = s.commits.ok ? activityStats(s.commits.value, s.repository.pushedAt, now) : null;
      const snap: EngineeringSnapshot = {
        id: `${organizationId}_${s.repository.id}_${hour}`, organizationId, repositoryId: s.repository.id, capturedAt: now.toISOString(),
        issueCounts: { open: s.issues.ok ? s.issues.value.length : -1, openBugs: s.issues.ok ? bugStats(s.issues.value, cfg()).total : -1 },
        pullRequestCounts: { open: pr?.open ?? -1, stale: pr?.stale ?? -1 },
        workflowSummary: { completedRuns: ci?.considered ?? -1, successRate: ci?.successRate ?? null,
          latestConclusion: s.workflowRuns.ok ? (s.workflowRuns.value[0]?.conclusion ?? null) : null },
        activitySummary: { commitsInWindow: act?.commitsInWindow ?? -1, lastCommitAt: act?.lastActivityAt ?? null },
        dataSource: s.source, isDemoData: s.source === "fixture",
      };
      await ctx.store.snapshots.upsert(snap);
      written.push(snap.id);
    }
    ok(res, { snapshotIds: written, unreachableRepositories: unreachable, capturedAt: now.toISOString(),
      note: "Counts of -1 mean the signal could not be retrieved." }, meta());
  });
  return r;
}
