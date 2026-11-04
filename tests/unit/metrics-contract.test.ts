import { describe, expect, it } from "vitest";
import { DEFAULT_HEALTH_CONFIG as cfg } from "../../src/domain/health/health.config.js";
import { bugSeverity, ciStats, isStalePullRequest, taskStats } from "../../src/domain/health/metrics.js";
import { validateAgentResult, type Finding } from "../../src/agents/contract.js";
import { assertTransition, canTransition, isTerminal } from "../../src/domain/investigations/state.js";
import { EvidenceLedger } from "../../src/agents/tools/evidence-ledger.js";
import { verifyFindings } from "../../src/agents/review/verification.js";
import { ToolRunner } from "../../src/agents/tools/registry.js";
import { loadEnv } from "../../src/config/env.js";
import { NOW } from "../helpers/setup.js";

const pr = (updatedDaysAgo: number, draft = false) => ({ number: 1, title: "x", draft, createdAt: NOW.toISOString(), url: "https://x.invalid/1",
  updatedAt: new Date(NOW.getTime() - updatedDaysAgo * 86_400_000).toISOString(), author: null, requestedReviewers: 0, baseBranch: "main" });
const task = (status: any, dueDaysFromNow: number | null, assignee: string | null = "u") => ({
  id: `t${Math.random()}`, organizationId: "o", projectId: "p", title: "t", description: "", status, priority: "medium" as const, assigneeUid: assignee,
  dueDate: dueDaysFromNow === null ? null : new Date(NOW.getTime() + dueDaysFromNow * 86_400_000).toISOString(), createdAt: "", updatedAt: "" });
const run = (conclusion: string | null, hoursAgo: number, branch = "main", status = "completed") => ({ id: hoursAgo, name: "CI", event: "push", status, conclusion,
  headBranch: branch, createdAt: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(), updatedAt: "", url: "https://x.invalid/r", runAttempt: 1 });

describe("stale pull-request rule", () => {
  it("is stale at or beyond the threshold and never for drafts", () => {
    expect(isStalePullRequest(pr(6.9), NOW, 7)).toBe(false);
    expect(isStalePullRequest(pr(7), NOW, 7)).toBe(true);
    expect(isStalePullRequest(pr(30, true), NOW, 7)).toBe(false);
  });
});

describe("project completion and task statistics", () => {
  it("completion = done/total; overdue = open tasks past due; unassigned open tasks counted", () => {
    const s = taskStats([task("done", -3), task("in_progress", -1), task("blocked", 5, null), task("todo", null)],
      { startDate: new Date(NOW.getTime() - 50 * 86_400_000).toISOString(), dueDate: new Date(NOW.getTime() + 50 * 86_400_000).toISOString() }, NOW);
    expect(s.completion).toBe(0.25);
    expect(s.overdue).toHaveLength(1);
    expect(s.blocked).toHaveLength(1);
    expect(s.unassignedOpen).toHaveLength(1);
    expect(s.expectedProgress).toBeCloseTo(0.5, 5);
  });
  it("completion is null with no tasks", () => { expect(taskStats([], { startDate: null, dueDate: null }, NOW).completion).toBeNull(); });
});

describe("CI statistics", () => {
  it("uses default-branch completed runs, ignores cancelled/in-progress, counts consecutive failures from the newest", () => {
    const s = ciStats([run("failure", 1), run("failure", 2), run("success", 3), run("cancelled", 4), run(null, 0, "main", "in_progress"), run("failure", 5, "feature")], "main", cfg);
    expect(s).toMatchObject({ considered: 3, successes: 1, failures: 2, consecutiveFailures: 2, branchScope: "default" });
  });
  it("falls back to all branches only when the default branch has no runs", () => {
    expect(ciStats([run("success", 1, "dev")], "main", cfg).branchScope).toBe("all");
    expect(ciStats([], "main", cfg)).toMatchObject({ successRate: null, branchScope: "none" });
  });
  it("classifies bug severity from labels, case-insensitively", () => {
    const i = (labels: string[]) => ({ number: 1, title: "", state: "open", labels, createdAt: "", updatedAt: "", closedAt: null, url: "", author: null, assignees: [] });
    expect(bugSeverity(i(["bug", "Severity:Critical"]), cfg)).toBe("critical");
    expect(bugSeverity(i(["bug", "P1"]), cfg)).toBe("high");
    expect(bugSeverity(i(["bug"]), cfg)).toBe("unclassified");
  });
});

describe("agent contract and investigation state", () => {
  it("accepts valid results and rejects malformed ones", () => {
    const ok = { agentId: "github", status: "completed", summary: "s", summarySource: "rules", findings: [], warnings: [], unavailableData: [] };
    expect(validateAgentResult(ok).status).toBe("completed");
    expect(() => validateAgentResult({ ...ok, status: "done" })).toThrow();
    expect(() => validateAgentResult({ ...ok, findings: [{ id: "f", title: "t" }] })).toThrow();
  });
  it("only allows forward transitions and freezes terminal states", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "partial")).toBe(true);
    expect(canTransition("completed", "running")).toBe(false);
    expect(isTerminal("failed")).toBe(true);
    expect(() => assertTransition("partial", "completed")).toThrow(/Invalid investigation status transition/);
  });
});

describe("deterministic evidence verification", () => {
  const ledger = new EvidenceLedger();
  const real = ledger.record({ sourceType: "github", sourceId: "pr:api#7", details: { number: 7, updatedAt: "2026-09-01T00:00:00Z" } });
  const finding = (over: Partial<Finding>): Finding => ({ id: "f", agentId: "github", kind: "fact", title: "t", description: "d", severity: "high",
    category: "c", projectId: null, repositoryId: null, evidence: [real], limitations: [], ...over });

  it("verifies findings whose evidence matches the ledger", () => {
    expect(verifyFindings([finding({})], ledger)[0].verification).toBe("verified");
  });
  it("rejects fabricated or altered evidence and findings without evidence", () => {
    const [fake, altered, none] = verifyFindings([
      finding({ evidence: [{ sourceType: "github", sourceId: "pr:api#999", details: {} }] }),
      finding({ evidence: [{ ...real, details: { number: 7, updatedAt: "2026-10-25T00:00:00Z" } }] }),
      finding({ evidence: [] }),
    ], ledger);
    expect(fake.verification).toBe("unverified");
    expect(fake.reviewNotes!.join()).toMatch(/was not retrieved/);
    expect(altered.reviewNotes!.join()).toMatch(/does not match/);
    expect(none.verification).toBe("unverified");
  });
  it("caps hypotheses at medium and needs two evidence items for a critical inference", () => {
    const [h, inf] = verifyFindings([finding({ kind: "hypothesis", severity: "critical" }), finding({ kind: "inference", severity: "critical" })], ledger);
    expect(h).toMatchObject({ verification: "hypothesis", severity: "medium" });
    expect(inf.severity).toBe("high");
  });
});

describe("tool runner", () => {
  const runner = (max = 2) => new ToolRunner({} as any, max, async () => {});
  it("refuses tools the agent is not permitted to use", async () => {
    await expect(runner().call("review", "listRepositories", {} as never)).rejects.toMatchObject({ code: "TOOL_NOT_PERMITTED" });
    await expect(runner().call("github", "getProjectTasks" as any, { projectId: "p" } as never)).rejects.toMatchObject({ code: "TOOL_NOT_PERMITTED" });
  });
  it("validates tool input before execution", async () => {
    await expect(runner().call("github", "getRepositorySignals", { repositoryId: "../../etc" })).rejects.toMatchObject({ code: "INVALID_TOOL_INPUT" });
  });
  it("enforces the per-investigation tool-call budget", async () => {
    const r = runner(0);
    await expect(r.call("github", "listRepositories", {} as never)).rejects.toMatchObject({ code: "TOOL_BUDGET_EXCEEDED" });
  });
});

describe("environment validation", () => {
  it("refuses dev auth in production and explains missing credentials", () => {
    expect(() => loadEnv({ NODE_ENV: "production", AUTH_MODE: "dev", STORAGE_MODE: "memory", GITHUB_MODE: "fixture" } as any)).toThrow(/AUTH_MODE=dev is not allowed/);
    expect(() => loadEnv({ STORAGE_MODE: "memory", AUTH_MODE: "dev", GITHUB_MODE: "live" } as any)).toThrow(/GITHUB_TOKEN is required/);
    expect(() => loadEnv({ GITHUB_MODE: "fixture", AUTH_MODE: "dev" } as any)).toThrow(/FIREBASE_PROJECT_ID is required/);
    expect(() => loadEnv({ STORAGE_MODE: "memory", AUTH_MODE: "dev", GITHUB_MODE: "fixture", ENABLED_AGENTS: "github" } as any)).toThrow(/must include manager/);
  });
  it("defaults CORS to no browser origins", () => {
    expect(loadEnv({ STORAGE_MODE: "memory", AUTH_MODE: "dev", GITHUB_MODE: "fixture" } as any).CORS_ORIGINS).toEqual([]);
  });
});

describe("tool budget exhaustion is reported, not hidden", () => {
  it("a tiny budget yields a partial investigation that lists the gaps", async () => {
    const { makeApp, auth, OWNER } = await import("../helpers/setup.js");
    const request = (await import("supertest")).default;
    const { app, ctx } = await makeApp({ env: { MAX_AGENT_TOOL_CALLS: "5" } });
    const res = await request(app).post("/api/v1/agents/investigations").set(auth(OWNER)).send({ organizationId: "org_demo", query: "health?" });
    await ctx.investigations.waitFor(res.body.data.investigationId);
    const inv = await ctx.store.investigations.get(res.body.data.investigationId);
    expect(inv!.status).toBe("partial");
    expect(inv!.finalReport!.unavailableData.join(" ")).toMatch(/TOOL_BUDGET_EXCEEDED/);
    expect(inv!.toolCallsUsed).toBe(5);
  });
});

describe("user-facing wording", () => {
  it("pluralizes correctly", async () => {
    const { plural } = await import("../../src/agents/agent.types.js");
    expect([plural(1, "repository"), plural(2, "repository"), plural(3, "bug"), plural(2, "day")]).toEqual(["1 repository", "2 repositories", "3 bugs", "2 days"]);
  });
});
