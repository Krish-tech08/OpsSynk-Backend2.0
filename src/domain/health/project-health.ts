import type { HealthConfig } from "./health.config.js";
import type { CompanyHealth, HealthCategory, HealthStatus, ProjectHealth, SubScore } from "./health.types.js";
import { activityScore, bugScore, ciScore, combine, deliveryScore, mean, pullRequestScore } from "./formulas.js";
import { activityStats, bugStats, ciStats, prStats, taskStats } from "./metrics.js";
import type { RepositorySignals } from "../../integrations/github/github.types.js";
import type { Project, Task } from "../../types/domain.js";
import { daysBetween } from "../../utils/time.js";

/**
 * Project health from tasks plus the signals of its mapped repositories.
 * Multi-repository rules: bugs and pull requests are pooled across repositories; CI and activity
 * are the mean of the per-repository sub-scores that are available.
 */
export function computeProjectHealth(
  project: Project, tasks: Task[], repos: RepositorySignals[], cfg: HealthConfig, now: Date, unreachableRepos: string[] = [],
): ProjectHealth {
  const ts = taskStats(tasks, project, now);
  const delivery = deliveryScore({ total: ts.total, done: ts.done, overdue: ts.overdue.length, blocked: ts.blocked.length, expectedProgress: ts.expectedProgress }, cfg);

  const repositoryErrors: ProjectHealth["repositoryErrors"] = unreachableRepos.map((r) => ({ repositoryId: r, signal: "repository", code: "UNAVAILABLE", message: "Repository could not be read." }));
  const evidence: ProjectHealth["evidence"] = {
    stalePullRequests: [], openBugs: [], recentFailedRuns: [],
    overdueTasks: ts.overdue.map((t) => ({ taskId: t.id, title: t.title, dueDate: t.dueDate!, status: t.status })),
    blockedTasks: ts.blocked.map((t) => ({ taskId: t.id, title: t.title })),
  };

  // Pooled bug and PR counts; per-repo CI and activity scores.
  let bugCounts = null as Record<"critical" | "high" | "medium" | "low" | "unclassified", number> | null;
  let prPool = null as { open: number; stale: number } | null;
  const ciScores: SubScore[] = [];
  const activityScores: SubScore[] = [];

  for (const r of repos) {
    const repoId = r.repository.id;
    const note = (signal: string, s: { ok: false; error: string; code: string }) =>
      repositoryErrors.push({ repositoryId: repoId, signal, code: s.code, message: s.error });

    if (r.issues.ok) {
      const b = bugStats(r.issues.value, cfg);
      bugCounts ??= { critical: 0, high: 0, medium: 0, low: 0, unclassified: 0 };
      for (const k of Object.keys(b.counts) as Array<keyof typeof b.counts>) bugCounts[k] += b.counts[k];
      for (const x of b.bugs) evidence.openBugs.push({ repositoryId: repoId, number: x.issue.number, title: x.issue.title, url: x.issue.url, severity: x.severity });
    } else note("issues", r.issues);

    if (r.pullRequests.ok) {
      const p = prStats(r.pullRequests.value, now, cfg.windows.stalePrDays);
      prPool = { open: (prPool?.open ?? 0) + p.open, stale: (prPool?.stale ?? 0) + p.stale };
      for (const pr of p.staleItems) evidence.stalePullRequests.push({
        repositoryId: repoId, number: pr.number, title: pr.title, url: pr.url, daysSinceUpdate: Math.floor(daysBetween(pr.updatedAt, now)),
      });
    } else note("pullRequests", r.pullRequests);

    if (r.workflowRuns.ok) {
      ciScores.push(ciScore(ciStats(r.workflowRuns.value, r.repository.defaultBranch, cfg), cfg));
      for (const run of r.workflowRuns.value.filter((x) => x.conclusion && cfg.ci.failureConclusions.includes(x.conclusion)).slice(0, 5))
        evidence.recentFailedRuns.push({ repositoryId: repoId, id: run.id, name: run.name, url: run.url, conclusion: run.conclusion!, createdAt: run.createdAt });
    } else note("workflowRuns", r.workflowRuns);

    if (r.commits.ok) activityScores.push(activityScore(activityStats(r.commits.value, r.repository.pushedAt, now), cfg));
    else note("commits", r.commits);
  }

  const meanSub = (category: HealthCategory, scores: SubScore[], noun: string): SubScore => {
    const vals = scores.map((s) => s.score).filter((v): v is number => v !== null);
    const m = mean(vals);
    if (m === null) return { category, score: null, reason: scores[0]?.reason ?? `No ${noun} data available for the mapped repositories.`, inputs: {} };
    return { category, score: Math.round(m * 10) / 10, reason: scores.length > 1 ? `Mean of ${vals.length} repositories.` : null,
      inputs: { ...(scores.length === 1 ? scores[0].inputs : {}), repositoriesWithData: vals.length } };
  };

  const subScores: SubScore[] = [
    delivery,
    repos.length ? meanSub("ci", ciScores, "CI") : { category: "ci", score: null, reason: "No repositories are mapped to this project.", inputs: {} },
    repos.length ? bugScore(bugCounts, cfg) : { category: "bugs", score: null, reason: "No repositories are mapped to this project.", inputs: {} },
    repos.length ? pullRequestScore(prPool, cfg) : { category: "pullRequests", score: null, reason: "No repositories are mapped to this project.", inputs: {} },
    repos.length ? meanSub("activity", activityScores, "activity") : { category: "activity", score: null, reason: "No repositories are mapped to this project.", inputs: {} },
  ];
  const combined = combine(subScores, cfg);
  return {
    ...combined, projectId: project.id, projectName: project.name, repositoryIds: project.repositoryIds, subScores, evidence, repositoryErrors,
    isDemoData: Boolean(project.isDemoData) || repos.some((r) => r.source === "fixture"),
    dataSource: repos.some((r) => r.source === "fixture") ? "fixture" : "github",
    computedAt: now.toISOString(),
  };
}

/** Company health: per-category mean of project sub-scores, combined with the same weights. */
export function computeCompanyHealth(
  organizationId: string, projects: ProjectHealth[], excluded: CompanyHealth["excludedProjects"], cfg: HealthConfig, now: Date,
): CompanyHealth {
  const categories: HealthCategory[] = ["delivery", "ci", "bugs", "pullRequests", "activity"];
  const categoryScores: Partial<Record<HealthCategory, number | null>> = {};
  const subs: SubScore[] = categories.map((c) => {
    const vals = projects.map((p) => p.subScores.find((s) => s.category === c)?.score).filter((v): v is number => v !== null && v !== undefined);
    const m = mean(vals);
    categoryScores[c] = m === null ? null : Math.round(m * 10) / 10;
    return { category: c, score: categoryScores[c] ?? null, reason: m === null ? "No project has this signal." : null, inputs: { projectsWithData: vals.length } };
  });
  const combined = combine(subs, cfg);
  const projectCounts: Record<HealthStatus, number> = { healthy: 0, warning: 0, critical: 0, insufficient_data: 0 };
  for (const p of projects) projectCounts[p.status]++;
  return {
    ...combined, organizationId, categoryScores,
    projects: projects.map((p) => ({ projectId: p.projectId, projectName: p.projectName, score: p.score, status: p.status, coverage: p.coverage, missingSignals: p.missingSignals })),
    projectCounts, excludedProjects: excluded,
    containsDemoData: projects.some((p) => p.isDemoData),
    dataSource: projects.some((p) => p.dataSource === "fixture") ? "fixture" : "github",
    computedAt: now.toISOString(),
  };
}
