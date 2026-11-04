import { describe, expect, it } from "vitest";
import { DEFAULT_HEALTH_CONFIG as cfg, loadHealthConfig } from "../../src/domain/health/health.config.js";
import { activityScore, bugScore, ciScore, combine, deliveryScore, pullRequestScore, statusFor } from "../../src/domain/health/formulas.js";
import type { SubScore } from "../../src/domain/health/health.types.js";

const sub = (category: SubScore["category"], score: number | null): SubScore => ({ category, score, reason: null, inputs: {} });

describe("delivery formula", () => {
  it("is unavailable (null, not 0) without tasks", () => {
    const s = deliveryScore({ total: 0, done: 0, overdue: 0, blocked: 0, expectedProgress: null }, cfg);
    expect(s.score).toBeNull();
    expect(s.reason).toMatch(/no tasks/);
  });
  it("applies overdue, blocked and schedule-gap penalties", () => {
    // 100 − 60·(1/5) − 30·(1/5) − 50·max(0, 0.8 − 0.4) = 100 − 12 − 6 − 20 = 62
    const s = deliveryScore({ total: 5, done: 2, overdue: 1, blocked: 1, expectedProgress: 0.8 }, cfg);
    expect(s.score).toBe(62);
  });
  it("skips the schedule gap when dates are missing and says so", () => {
    const s = deliveryScore({ total: 4, done: 4, overdue: 0, blocked: 0, expectedProgress: null }, cfg);
    expect(s.score).toBe(100);
    expect(s.reason).toMatch(/Schedule gap not applied/);
  });
  it("never goes below 0", () => {
    expect(deliveryScore({ total: 2, done: 0, overdue: 2, blocked: 2, expectedProgress: 1 }, cfg).score).toBe(0);
  });
});

describe("CI formula", () => {
  const stats = (successes: number, failures: number, consecutive: number) => ({
    considered: successes + failures, successes, failures, successRate: (successes + failures) ? successes / (successes + failures) : null,
    consecutiveFailures: consecutive, lastSuccessAt: null, branchScope: "default" as const,
  });
  it("is unavailable when runs could not be read, or none completed", () => {
    expect(ciScore(null, cfg).score).toBeNull();
    expect(ciScore(stats(0, 0, 0), cfg).score).toBeNull();
  });
  it("is the success rate when the latest run passed", () => { expect(ciScore(stats(7, 3, 0), cfg).score).toBe(70); });
  it("penalizes consecutive failures beyond the first, capped", () => {
    expect(ciScore(stats(7, 3, 3), cfg).score).toBe(50);   // 70 − 10·2
    expect(ciScore(stats(5, 5, 5), cfg).score).toBe(20);   // 50 − min(30, 40)
  });
});

describe("bug, PR and activity formulas", () => {
  it("bugs: weighted load, zero bugs = 100, unavailable = null", () => {
    expect(bugScore({ critical: 1, high: 1, medium: 1, low: 1, unclassified: 1 }, cfg).score).toBe(100 - (25 + 10 + 4 + 1 + 4));
    expect(bugScore({ critical: 0, high: 0, medium: 0, low: 0, unclassified: 0 }, cfg).score).toBe(100);
    expect(bugScore(null, cfg).score).toBeNull();
    expect(bugScore({ critical: 5, high: 0, medium: 0, low: 0, unclassified: 0 }, cfg).score).toBe(0);
  });
  it("pull requests: stale ratio and count", () => {
    expect(pullRequestScore({ open: 0, stale: 0 }, cfg).score).toBe(100);
    expect(pullRequestScore({ open: 3, stale: 2 }, cfg).score).toBe(44);   // 100 − 40 − 16
    expect(pullRequestScore(null, cfg).score).toBeNull();
  });
  it("activity: recency and volume", () => {
    expect(activityScore({ commitsInWindow: 10, daysSinceLastActivity: 1 }, cfg).score).toBe(100);
    expect(activityScore({ commitsInWindow: 0, daysSinceLastActivity: 40 }, cfg).score).toBe(0);
    // recency at 16.5 days = 100·(1 − 13.5/27) = 50 → 0.6·50 + 0.4·(100·5/10) = 30 + 20
    expect(activityScore({ commitsInWindow: 5, daysSinceLastActivity: 16.5 }, cfg).score).toBe(50);
    expect(activityScore({ commitsInWindow: 0, daysSinceLastActivity: null }, cfg).score).toBeNull();
    expect(activityScore(null, cfg).score).toBeNull();
  });
});

describe("weighted combination", () => {
  it("combines with the configured weights", () => {
    const r = combine([sub("delivery", 100), sub("ci", 80), sub("bugs", 60), sub("pullRequests", 40), sub("activity", 20)], cfg);
    expect(r.score).toBe(Math.round((30 + 20 + 12 + 6 + 2) * 10) / 10);
    expect(r.coverage).toBe(1);
    expect(r.status).toBe("warning");
  });
  it("excludes unavailable signals and renormalizes the remaining weights", () => {
    const r = combine([sub("delivery", null), sub("ci", 100), sub("bugs", 50), sub("pullRequests", null), sub("activity", 100)], cfg);
    // available weights 0.25 + 0.20 + 0.10 = 0.55 → (25 + 10 + 10) / 0.55
    expect(r.score).toBe(Math.round((45 / 0.55) * 10) / 10);
    expect(r.coverage).toBe(0.55);
    expect(r.missingSignals).toEqual(["delivery", "pullRequests"]);
    expect(r.appliedWeights.ci).toBeCloseTo(0.25 / 0.55, 3);
  });
  it("returns insufficient_data (score null) below the minimum coverage, never zero", () => {
    const r = combine([sub("delivery", null), sub("ci", 100), sub("bugs", null), sub("pullRequests", null), sub("activity", null)], cfg);
    expect(r).toMatchObject({ score: null, status: "insufficient_data" });
    expect(r.coverage).toBe(0.25);
  });
  it("maps scores to configurable bands", () => {
    expect([statusFor(80, cfg), statusFor(79.9, cfg), statusFor(50, cfg), statusFor(49.9, cfg)]).toEqual(["healthy", "warning", "warning", "critical"]);
  });
});

describe("health configuration", () => {
  it("rejects weights that do not sum to 1 and inverted bands", () => {
    expect(() => loadHealthConfig(undefined, { weights: { delivery: 0.5 } })).toThrow(/sum to 1/);
    expect(() => loadHealthConfig(undefined, { bands: { warning: 90 } })).toThrow(/bands.warning/);
  });
  it("accepts a valid override (deep merge)", () => {
    const c = loadHealthConfig(undefined, { windows: { stalePrDays: 14 }, bands: { healthy: 85, warning: 60 } });
    expect(c.windows).toMatchObject({ stalePrDays: 14, activityDays: 14 });
    expect(statusFor(84, c)).toBe("warning");
  });
});
