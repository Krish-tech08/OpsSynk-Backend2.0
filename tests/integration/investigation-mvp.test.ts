import { describe, expect, it } from "vitest";
import request from "supertest";
import { auth, makeApp, OWNER, scriptedGemini, VIEWER } from "../helpers/setup.js";

const MVP = { ENABLED_AGENTS: "manager,github,project" };
const start = async (app: any, body: object = {}, headers: Record<string, string> = {}) =>
  request(app).post("/api/v1/agents/investigations").set(auth(OWNER)).set(headers)
    .send({ organizationId: "org_demo", query: "What is the current engineering health?", ...body });

async function runToEnd(o: Parameters<typeof makeApp>[0] = {}) {
  const { app, ctx } = await makeApp({ ...o, env: { ...MVP, ...(o.env ?? {}) } });
  const res = await start(app);
  expect(res.status).toBe(202);
  const id = res.body.data.investigationId;
  await ctx.investigations.waitFor(id);
  const inv = (await request(app).get(`/api/v1/agents/investigations/${id}`).set(auth(OWNER))).body.data;
  const events = (await request(app).get(`/api/v1/agents/investigations/${id}/events`).set(auth(OWNER))).body.data;
  return { app, ctx, id, inv, events };
}

describe("Phase 3 MVP: Manager → GitHub Agent → Project Agent", () => {
  it("completes in rules-only mode with a traceable, evidence-backed report", async () => {
    const { inv, events } = await runToEnd();
    expect(inv.status).toBe("completed");
    expect(inv.plan).toMatchObject({ agents: ["github", "project"], source: "rules" });
    expect(inv.agentStatuses).toMatchObject({ manager: "completed", github: "completed", project: "completed" });

    // Events: persisted, contiguous sequence numbers, real lifecycle order.
    expect(events.map((e: any) => e.sequence)).toEqual(events.map((_: any, i: number) => i + 1));
    expect(events[0].eventType).toBe("investigation.started");
    expect(events.at(-1).eventType).toBe("investigation.completed");
    const types = events.map((e: any) => `${e.agentId ?? "-"}:${e.eventType}`);
    for (const t of ["manager:manager.plan_created", "github:agent.started", "github:tool.completed", "github:agent.findings_ready", "project:agent.findings_ready"])
      expect(types).toContain(t);
    expect(types.indexOf("github:agent.findings_ready")).toBeLessThan(types.indexOf("-:investigation.completed"));

    const report = inv.finalReport;
    expect(report.dataProvenance).toMatchObject({ github: "fixture", containsDemoData: true });
    expect(report.health).toMatchObject({ projectCounts: { critical: 3, warning: 4, healthy: 5 } });
    expect(report.warnings.join(" ")).toMatch(/Review agent is not enabled/);

    // Every finding is verified against retrieved data and carries evidence.
    expect(report.findings.length).toBeGreaterThan(5);
    for (const f of report.findings) {
      expect(f.evidence.length).toBeGreaterThan(0);
      expect(f.verification).toBe("verified");
    }
    const stale = report.findings.find((f: any) => f.id === "github:stale-prs:mobile-app-ios");
    expect(stale.evidence.map((e: any) => e.sourceId)).toEqual(["pr:mobile-app-ios#17", "pr:mobile-app-ios#18"]);
    expect(stale.evidence[0].sourceUrl).toBe("https://fixtures.opssynk.invalid/SynkStack/mobile-app-ios/pull/17");
    const critical = report.findings.find((f: any) => f.id === "project:health:demo_payments_sdk");
    expect(critical).toMatchObject({ kind: "inference", severity: "critical", category: "project-health" });
    expect(critical.evidence.map((e: any) => e.sourceId)).toContain("project-health:demo_payments_sdk");
    const quiet = report.findings.find((f: any) => f.id === "github:low-activity:mobile-payments-sdk");
    expect(quiet.description).toMatch(/35 days ago/);

    // Recommendations cite verified findings only.
    const ids = new Set(report.findings.filter((f: any) => f.verification === "verified").map((f: any) => f.id));
    expect(report.recommendations.length).toBeGreaterThan(0);
    for (const r of report.recommendations) expect(r.findingIds.every((x: string) => ids.has(x))).toBe(true);
    expect(report.recommendations[0].priority).toBe("now");
    expect(report.executiveSummarySource).toBe("rules");
    expect(report.budgets.modelCallsUsed).toBe(0);
  });

  it("uses Gemini within limits and rejects ungrounded or unsupported model output", async () => {
    const calls: string[] = [];
    const gemini = scriptedGemini(({ purpose, prompt }) => {
      if (purpose === "plan") return { agents: ["github", "project"], rationale: "Health needs repository and delivery data." };
      if (purpose === "summary") return { summary: prompt.includes('"title":"No recent commits') ? "Repositories show 99 problems." : "Several repositories need attention." };
      const realId = /"id":"(project:health:[^"]+)"/.exec(prompt)![1];
      return { executiveSummary: "Delivery risk is concentrated in a few projects.",
        recommendations: [
          { title: "Escalate the critical project", rationale: "It is critical.", priority: "now", findingIds: [realId] },
          { title: "Invented", rationale: "Not supported.", priority: "soon", findingIds: ["made-up-finding"] },
        ] };
    }, calls);
    const { inv } = await runToEnd({ gemini, env: { MAX_MODEL_CALLS_PER_INVESTIGATION: "4" } });
    const r = inv.finalReport;
    expect(inv.plan.source).toBe("model");
    expect(calls).toEqual(["plan", "summary", "summary", "synthesis"]);
    expect(r.budgets).toMatchObject({ modelCallsUsed: 4, modelCallLimit: 4 });
    expect(r.recommendations.map((x: any) => x.title)).toEqual(["Escalate the critical project"]);
    expect(r.warnings.join(" ")).toMatch(/1 AI recommendation\(s\) dropped/);
    expect(r.agentSummaries.find((a: any) => a.agentId === "github")).toMatchObject({ summarySource: "rules" });   // "99" was not grounded
    expect(r.agentSummaries.find((a: any) => a.agentId === "project")).toMatchObject({ summarySource: "model" });
    expect(r.executiveSummarySource).toBe("model");
  });

  it("never exceeds the model-call budget (limit 1 → only the final synthesis runs)", async () => {
    const calls: string[] = [];
    const gemini = scriptedGemini(({ purpose }) => purpose === "synthesis" ? { executiveSummary: "Summary.", recommendations: [] } : { summary: "x" }, calls);
    const { inv } = await runToEnd({ gemini, env: { MAX_MODEL_CALLS_PER_INVESTIGATION: "1" } });
    expect(calls).toEqual(["synthesis"]);
    expect(inv.finalReport.budgets.modelCallsUsed).toBe(1);
    expect(inv.plan.source).toBe("rules");
    expect(inv.finalReport.recommendations.every((x: any) => x.source === "rules")).toBe(true);   // empty model list → rules
  });

  it("falls back to rules when Gemini is rate limited, and still completes", async () => {
    const gemini = scriptedGemini(() => Object.assign(new Error("RESOURCE_EXHAUSTED"), { status: 429 }));
    const { inv } = await runToEnd({ gemini });
    expect(inv.status).toBe("completed");
    expect(inv.finalReport.warnings.join(" ")).toMatch(/GEMINI_RATE_LIMITED/);
    expect(inv.finalReport.executiveSummarySource).toBe("rules");
  });

  it("idempotency key and duplicate submits never start a second investigation", async () => {
    const { app, ctx } = await makeApp({ env: MVP });
    const a = await start(app, {}, { "Idempotency-Key": "demo-key-0001" });
    const b = await start(app, {}, { "Idempotency-Key": "demo-key-0001" });
    expect(b.status).toBe(200);
    expect(b.body.data).toMatchObject({ investigationId: a.body.data.investigationId, created: false });
    // Two identical submits at the same moment (double tap) → one investigation.
    const [c, d] = await Promise.all([start(app, { query: "Which projects are at risk?" }), start(app, { query: "Which projects are at risk?" })]);
    expect(d.body.data.investigationId).toBe(c.body.data.investigationId);
    expect([c.body.data.created, d.body.data.created].sort()).toEqual([false, true]);
    await Promise.all([a, c].map((x) => ctx.investigations.waitFor(x.body.data.investigationId)));
    expect((await ctx.store.investigations.list("org_demo", 50))).toHaveLength(2);
  });

  it("polling with `after` and SSE replay with Last-Event-ID (reconnect does not restart anything)", async () => {
    const { app, id, events, ctx } = await runToEnd();
    const poll = await request(app).get(`/api/v1/agents/investigations/${id}/events?after=3`).set(auth(VIEWER));
    expect(poll.body.data[0].sequence).toBe(4);
    expect(poll.body.meta).toMatchObject({ done: true, investigationStatus: "completed" });
    const sse = await request(app).get(`/api/v1/agents/investigations/${id}/stream`).set(auth(VIEWER)).set("Last-Event-ID", String(events.length - 2));
    expect(sse.headers["content-type"]).toMatch(/text\/event-stream/);
    const ids = [...sse.text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual([events.length - 1, events.length]);
    expect(sse.text).toMatch(/event: investigation\.completed/);
    expect((await ctx.store.investigations.list("org_demo", 10))).toHaveLength(1);
    const report = await request(app).get(`/api/v1/reports/${id}`).set(auth(VIEWER));
    expect(report.body.data.investigationId).toBe(id);
  });
});
