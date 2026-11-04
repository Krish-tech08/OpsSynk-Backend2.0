import { readFileSync } from "node:fs";
import { z } from "zod";

/** Every number in the health model lives here. See docs/health-scoring.md for the formulas. */
export const HealthConfigSchema = z.object({
  weights: z.object({
    delivery: z.number().min(0), ci: z.number().min(0), bugs: z.number().min(0),
    pullRequests: z.number().min(0), activity: z.number().min(0),
  }),
  bands: z.object({ healthy: z.number().min(0).max(100), warning: z.number().min(0).max(100) }),
  /** Minimum share of total weight that must be available; below it the status is insufficient_data. */
  minimumCoverage: z.number().min(0).max(1),
  windows: z.object({ activityDays: z.number().positive(), ciDays: z.number().positive(), stalePrDays: z.number().positive() }),
  delivery: z.object({ overduePenalty: z.number().min(0), blockedPenalty: z.number().min(0), scheduleGapPenalty: z.number().min(0) }),
  ci: z.object({
    successConclusions: z.array(z.string()), failureConclusions: z.array(z.string()),
    consecutiveFailurePenalty: z.number().min(0), maxConsecutiveFailurePenalty: z.number().min(0),
  }),
  bugs: z.object({
    bugLabels: z.array(z.string()),
    severityLabels: z.object({ critical: z.array(z.string()), high: z.array(z.string()), medium: z.array(z.string()), low: z.array(z.string()) }),
    severityWeights: z.object({ critical: z.number(), high: z.number(), medium: z.number(), low: z.number(), unclassified: z.number() }),
  }),
  pullRequests: z.object({ staleRatioPenalty: z.number().min(0), perStalePrPenalty: z.number().min(0) }),
  activity: z.object({
    fullScoreWithinDays: z.number().min(0), zeroScoreAfterDays: z.number().positive(),
    recencyWeight: z.number().min(0).max(1), commitsForFullVolume: z.number().positive(),
  }),
}).superRefine((c, ctx) => {
  const sum = Object.values(c.weights).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 1e-6) ctx.addIssue({ code: "custom", message: `weights must sum to 1 (got ${sum})`, path: ["weights"] });
  if (c.bands.warning >= c.bands.healthy) ctx.addIssue({ code: "custom", message: "bands.warning must be below bands.healthy", path: ["bands"] });
  if (c.activity.fullScoreWithinDays >= c.activity.zeroScoreAfterDays)
    ctx.addIssue({ code: "custom", message: "activity.fullScoreWithinDays must be below zeroScoreAfterDays", path: ["activity"] });
});
export type HealthConfig = z.infer<typeof HealthConfigSchema>;

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  weights: { delivery: 0.30, ci: 0.25, bugs: 0.20, pullRequests: 0.15, activity: 0.10 },
  bands: { healthy: 80, warning: 50 },
  minimumCoverage: 0.5,
  windows: { activityDays: 14, ciDays: 14, stalePrDays: 7 },
  delivery: { overduePenalty: 60, blockedPenalty: 30, scheduleGapPenalty: 50 },
  ci: {
    successConclusions: ["success"],
    failureConclusions: ["failure", "timed_out", "startup_failure"],
    consecutiveFailurePenalty: 10,
    maxConsecutiveFailurePenalty: 30,
  },
  bugs: {
    bugLabels: ["bug", "type:bug", "kind/bug", "type: bug"],
    severityLabels: {
      critical: ["critical", "severity:critical", "severity: critical", "p0", "sev1"],
      high: ["high", "severity:high", "severity: high", "p1", "sev2"],
      medium: ["medium", "severity:medium", "severity: medium", "p2", "sev3"],
      low: ["low", "severity:low", "severity: low", "p3", "sev4"],
    },
    severityWeights: { critical: 25, high: 10, medium: 4, low: 1, unclassified: 4 },
  },
  pullRequests: { staleRatioPenalty: 60, perStalePrPenalty: 8 },
  activity: { fullScoreWithinDays: 3, zeroScoreAfterDays: 30, recencyWeight: 0.6, commitsForFullVolume: 10 },
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function deepMerge<T>(base: T, override: unknown): T {
  if (!isObj(base) || !isObj(override)) return (override ?? base) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out as T;
}

/** Defaults, optionally overridden (deep-merged) by a JSON file. The result is validated. */
export function loadHealthConfig(path?: string, override?: unknown): HealthConfig {
  let cfg: unknown = DEFAULT_HEALTH_CONFIG;
  if (path) cfg = deepMerge(cfg, JSON.parse(readFileSync(path, "utf8")));
  if (override) cfg = deepMerge(cfg, override);
  return HealthConfigSchema.parse(cfg);
}
