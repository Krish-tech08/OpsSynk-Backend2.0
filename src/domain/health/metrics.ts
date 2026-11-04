import type { CommitItem, IssueItem, PullRequestItem, WorkflowRunItem } from "../../integrations/github/github.types.js";
import type { Project, Task } from "../../types/domain.js";
import type { HealthConfig } from "./health.config.js";
import { daysBetween } from "../../utils/time.js";

/** Deterministic signal extraction. No model involvement anywhere in this file. */

export const isStalePullRequest = (pr: PullRequestItem, now: Date, staleDays: number) =>
  !pr.draft && daysBetween(pr.updatedAt, now) >= staleDays;

export function prStats(pulls: PullRequestItem[], now: Date, staleDays: number) {
  const open = pulls.filter((p) => !p.draft);
  const stale = open.filter((p) => isStalePullRequest(p, now, staleDays));
  return { open: open.length, drafts: pulls.length - open.length, stale: stale.length, staleItems: stale };
}

const lower = (xs: string[]) => xs.map((x) => x.toLowerCase().trim());

export function isBug(issue: IssueItem, cfg: HealthConfig) {
  const labels = lower(issue.labels);
  return lower(cfg.bugs.bugLabels).some((b) => labels.includes(b));
}

export type BugSeverity = "critical" | "high" | "medium" | "low" | "unclassified";
export function bugSeverity(issue: IssueItem, cfg: HealthConfig): BugSeverity {
  const labels = lower(issue.labels);
  for (const sev of ["critical", "high", "medium", "low"] as const)
    if (lower(cfg.bugs.severityLabels[sev]).some((l) => labels.includes(l))) return sev;
  return "unclassified";
}

export function bugStats(issues: IssueItem[], cfg: HealthConfig) {
  const counts: Record<BugSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0, unclassified: 0 };
  const bugs = issues.filter((i) => isBug(i, cfg)).map((i) => ({ issue: i, severity: bugSeverity(i, cfg) }));
  for (const b of bugs) counts[b.severity]++;
  return { total: bugs.length, counts, bugs };
}

export interface CiStats {
  considered: number; successes: number; failures: number; successRate: number | null;
  consecutiveFailures: number; lastSuccessAt: string | null; branchScope: "default" | "all" | "none";
}

/**
 * CI stats over completed runs in the window. Uses default-branch runs when any exist, otherwise all runs.
 * Cancelled, skipped, neutral and in-progress runs are excluded from the rate.
 */
export function ciStats(runs: WorkflowRunItem[], defaultBranch: string, cfg: HealthConfig): CiStats {
  const completed = runs.filter((r) => r.status === "completed" && r.conclusion !== null);
  const onDefault = completed.filter((r) => r.headBranch === defaultBranch);
  const scope = onDefault.length ? onDefault : completed;
  const relevant = scope
    .filter((r) => cfg.ci.successConclusions.includes(r.conclusion!) || cfg.ci.failureConclusions.includes(r.conclusion!))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const successes = relevant.filter((r) => cfg.ci.successConclusions.includes(r.conclusion!)).length;
  let consecutiveFailures = 0;
  for (const r of relevant) { if (cfg.ci.failureConclusions.includes(r.conclusion!)) consecutiveFailures++; else break; }
  return {
    considered: relevant.length, successes, failures: relevant.length - successes,
    successRate: relevant.length ? successes / relevant.length : null,
    consecutiveFailures,
    lastSuccessAt: relevant.find((r) => cfg.ci.successConclusions.includes(r.conclusion!))?.createdAt ?? null,
    branchScope: relevant.length === 0 ? "none" : onDefault.length ? "default" : "all",
  };
}

/** Activity from default-branch commits in the window; falls back to the repository's last push time for recency. */
export function activityStats(commits: CommitItem[], pushedAt: string | null, now: Date) {
  const latest = commits.map((c) => c.committedAt).sort().at(-1) ?? null;
  const lastActivityAt = latest ?? pushedAt;
  return {
    commitsInWindow: commits.length,
    lastActivityAt,
    lastActivitySource: latest ? "commits" : pushedAt ? "pushed_at" : "none",
    daysSinceLastActivity: lastActivityAt ? daysBetween(lastActivityAt, now) : null,
  };
}

/** Task statistics. Completion uses task states only: done / total. */
export function taskStats(tasks: Task[], project: Pick<Project, "startDate" | "dueDate">, now: Date) {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "done").length;
  const open = tasks.filter((t) => t.status !== "done");
  const overdue = open.filter((t) => t.dueDate && new Date(t.dueDate) < now);
  const blocked = tasks.filter((t) => t.status === "blocked");
  const unassignedOpen = open.filter((t) => !t.assigneeUid);
  let expectedProgress: number | null = null;
  if (project.startDate && project.dueDate) {
    const start = new Date(project.startDate).getTime(), end = new Date(project.dueDate).getTime();
    if (end > start) expectedProgress = Math.min(1, Math.max(0, (now.getTime() - start) / (end - start)));
  }
  return {
    total, done, completion: total ? done / total : null, overdue, blocked, unassignedOpen, expectedProgress,
  };
}
