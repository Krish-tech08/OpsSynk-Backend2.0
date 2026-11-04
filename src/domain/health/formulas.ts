import type { HealthConfig } from "./health.config.js";
import type { CiStats } from "./metrics.js";
import type { CombinedScore, HealthCategory, HealthStatus, SubScore } from "./health.types.js";

/**
 * Health formulas. Each returns a SubScore with score 0–100, or null when data is unavailable.
 * Formulas are documented in docs/health-scoring.md; every constant comes from HealthConfig.
 */
const clamp = (v: number) => Math.max(0, Math.min(100, v));
const round1 = (v: number) => Math.round(v * 10) / 10;
const unavailable = (category: HealthCategory, reason: string): SubScore => ({ category, score: null, reason, inputs: {} });

/** delivery = 100 − overduePenalty·(overdue/total) − blockedPenalty·(blocked/total) − scheduleGapPenalty·max(0, expected − completion) */
export function deliveryScore(
  s: { total: number; done: number; overdue: number; blocked: number; expectedProgress: number | null },
  cfg: HealthConfig,
): SubScore {
  if (s.total === 0) return unavailable("delivery", "The project has no tasks.");
  const completion = s.done / s.total;
  const gap = s.expectedProgress === null ? 0 : Math.max(0, s.expectedProgress - completion);
  const score = clamp(100
    - cfg.delivery.overduePenalty * (s.overdue / s.total)
    - cfg.delivery.blockedPenalty * (s.blocked / s.total)
    - cfg.delivery.scheduleGapPenalty * gap);
  return {
    category: "delivery", score: round1(score),
    reason: s.expectedProgress === null ? "Schedule gap not applied: project start or due date missing." : null,
    inputs: { total: s.total, done: s.done, overdue: s.overdue, blocked: s.blocked,
      completion: round1(completion * 100), expectedProgress: s.expectedProgress === null ? null : round1(s.expectedProgress * 100) },
  };
}

/** ci = 100·successRate − min(maxPenalty, consecutivePenalty·max(0, consecutiveFailures − 1)) */
export function ciScore(s: CiStats | null, cfg: HealthConfig): SubScore {
  if (!s) return unavailable("ci", "Workflow runs could not be retrieved.");
  if (s.successRate === null) return unavailable("ci", "No completed workflow runs in the CI window.");
  const penalty = Math.min(cfg.ci.maxConsecutiveFailurePenalty, cfg.ci.consecutiveFailurePenalty * Math.max(0, s.consecutiveFailures - 1));
  return {
    category: "ci", score: round1(clamp(100 * s.successRate - penalty)), reason: null,
    inputs: { considered: s.considered, successes: s.successes, failures: s.failures,
      successRate: round1(s.successRate * 100), consecutiveFailures: s.consecutiveFailures, branchScope: s.branchScope },
  };
}

/** bugs = 100 − Σ(open bugs × severity weight). Zero open bugs = 100 (the signal was retrieved). */
export function bugScore(counts: Record<"critical" | "high" | "medium" | "low" | "unclassified", number> | null, cfg: HealthConfig): SubScore {
  if (!counts) return unavailable("bugs", "Issues could not be retrieved.");
  const w = cfg.bugs.severityWeights;
  const load = counts.critical * w.critical + counts.high * w.high + counts.medium * w.medium + counts.low * w.low + counts.unclassified * w.unclassified;
  return { category: "bugs", score: round1(clamp(100 - load)), reason: null, inputs: { ...counts, weightedLoad: load } };
}

/** pullRequests = 100 − staleRatioPenalty·(stale/open) − perStalePrPenalty·stale. No open PRs = 100. */
export function pullRequestScore(s: { open: number; stale: number } | null, cfg: HealthConfig): SubScore {
  if (!s) return unavailable("pullRequests", "Pull requests could not be retrieved.");
  if (s.open === 0) return { category: "pullRequests", score: 100, reason: "No open pull requests.", inputs: { open: 0, stale: 0 } };
  const score = clamp(100 - cfg.pullRequests.staleRatioPenalty * (s.stale / s.open) - cfg.pullRequests.perStalePrPenalty * s.stale);
  return { category: "pullRequests", score: round1(score), reason: null, inputs: { open: s.open, stale: s.stale } };
}

/**
 * activity = recencyWeight·recency + (1 − recencyWeight)·volume
 *   recency: 100 if days since last activity ≤ fullScoreWithinDays, 0 if ≥ zeroScoreAfterDays, linear between
 *   volume:  min(100, 100·commitsInWindow / commitsForFullVolume)
 */
export function activityScore(s: { commitsInWindow: number; daysSinceLastActivity: number | null } | null, cfg: HealthConfig): SubScore {
  if (!s) return unavailable("activity", "Commit history could not be retrieved.");
  if (s.daysSinceLastActivity === null) return unavailable("activity", "The repository has no recorded activity.");
  const a = cfg.activity;
  const d = s.daysSinceLastActivity;
  const recency = d <= a.fullScoreWithinDays ? 100 : d >= a.zeroScoreAfterDays ? 0
    : 100 * (1 - (d - a.fullScoreWithinDays) / (a.zeroScoreAfterDays - a.fullScoreWithinDays));
  const volume = Math.min(100, (100 * s.commitsInWindow) / a.commitsForFullVolume);
  return {
    category: "activity", score: round1(clamp(a.recencyWeight * recency + (1 - a.recencyWeight) * volume)), reason: null,
    inputs: { commitsInWindow: s.commitsInWindow, daysSinceLastActivity: round1(d), recency: round1(recency), volume: round1(volume) },
  };
}

export function statusFor(score: number, cfg: HealthConfig): Exclude<HealthStatus, "insufficient_data"> {
  return score >= cfg.bands.healthy ? "healthy" : score >= cfg.bands.warning ? "warning" : "critical";
}

/**
 * Weighted combination. Unavailable sub-scores are excluded and the remaining weights renormalized.
 * If the available weight share (coverage) is below minimumCoverage, the result is insufficient_data with score null.
 */
export function combine(subScores: SubScore[], cfg: HealthConfig): CombinedScore {
  const weights = cfg.weights as Record<HealthCategory, number>;
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const available = subScores.filter((s) => s.score !== null && weights[s.category] > 0);
  const availableWeight = available.reduce((a, s) => a + weights[s.category], 0);
  const coverage = total > 0 ? availableWeight / total : 0;
  const missingSignals = (Object.keys(weights) as HealthCategory[]).filter((c) => !available.some((s) => s.category === c));
  if (availableWeight === 0 || coverage + 1e-9 < cfg.minimumCoverage)
    return { score: null, status: "insufficient_data", coverage: round1(coverage * 100) / 100, appliedWeights: {}, missingSignals };
  const appliedWeights: Partial<Record<HealthCategory, number>> = {};
  let score = 0;
  for (const s of available) {
    const w = weights[s.category] / availableWeight;
    appliedWeights[s.category] = Math.round(w * 1000) / 1000;
    score += w * (s.score as number);
  }
  const rounded = round1(score);
  return { score: rounded, status: statusFor(rounded, cfg), coverage: Math.round(coverage * 100) / 100, appliedWeights, missingSignals };
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
