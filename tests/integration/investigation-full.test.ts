import { describe, expect, it } from "vitest";
import request from "supertest";
import { auth, makeApp, OWNER, scriptedGemini, VIEWER } from "../helpers/setup.js";
import { SPECIALIST_AGENTS, REVIEW_AGENT } from "../../src/agents/registry.js";
import type { Agent } from "../../src/agents/agent.types.js";

async function run(o: Parameters<typeof makeApp>[0] = {}, body: object = {}) {
  const { app, ctx } = await makeApp(o);
  const res = await request(app).post("/api/v1/agents/investigations").set(auth(OWNER))
    .send({ organizationId: "org_demo", query: "What is the current engineering health of the company?", ...body });
  const id = res.body.data.investigationId;
  await ctx.investigations.waitFor(id);
  const inv = (await request(app).get(`/api/v1/agents/investigations/${id}`).set(auth(OWNER))).body.data;
  const events = (await request(app).get(`/api/v1/agents/investigations/${id}/events`).set(auth(OWNER))).body.data;
  return { app, ctx, inv, events, report: inv.finalReport };
}
const byId = (report: any, id: string) => report.findings.find((f: any) => f.id === id);

describe("Phase 4: full six-agent workflow", () => {
  it("runs all agents and produces bug, CI, deployment and hypothesis findings with honest data gaps", async () => {
    const { inv, events, report } = await run();
    expect(events.some((e: any) => e.agentId === "bug" && e.metadata.cached === true)).toBe(true);   // shared GitHub results, not refetched
    expect(report.budgets.toolCallsUsed).toBeLessThanOrEqual(45);
    expect(inv.status).toBe("completed");
    expect(inv.plan.agents).toEqual(["github", "project", "bug", "devops"]);
    expect(inv.agentStatuses).toMatchObject({ manager: "completed", github: "completed", project: "completed", bug: "completed", devops: "completed", review: "completed" });
    const order = events.map((e: any) => `${e.agentId ?? "-"}:${e.eventType}`);
    // Bug/DevOps start only after GitHub and Project finished; review after both; terminal last.
    expect(order.indexOf("bug:agent.started")).toBeGreaterThan(order.indexOf("github:agent.findings_ready"));
    expect(order.indexOf("bug:agent.started")).toBeGreaterThan(order.indexOf("project:agent.findings_ready"));
    expect(order.indexOf("review:review.started")).toBeGreaterThan(order.indexOf("devops:agent.findings_ready"));
    expect(order.at(-1)).toBe("-:investigation.completed");

    const crit = byId(report, "bug:critical:mobile-payments-sdk");
    expect(crit).toMatchObject({ severity: "critical", kind: "fact", verification: "verified" });
    expect(crit.evidence.map((e: any) => e.sourceId)).toEqual(["issue:mobile-payments-sdk#302", "issue:mobile-payments-sdk#301"]);   // severity, then oldest first
    const hyp = byId(report, "bug:similar:mobile-payments-sdk#301|mobile-payments-sdk#302");
    expect(hyp).toMatchObject({ kind: "hypothesis", verification: "hypothesis", severity: "medium" });
    expect(hyp.description).toMatch(/not confirmed/);

    const ci = byId(report, "devops:ci-failing:mobile-payments-sdk");
    expect(ci.title).toMatch(/5 consecutive failures/);
    expect(ci.evidence).toHaveLength(5);
    expect(byId(report, "devops:ci-unstable:mobile-app-ios")).toMatchObject({ severity: "medium" });
    expect(byId(report, "devops:deployment-failed:mobile-payments-sdk")).toMatchObject({ severity: "high", category: "deployment-failed" });
    // No deployment records → explicitly "not assessed", never reported as healthy.
    expect(report.unavailableData.join(" ")).toMatch(/Deployment health not assessed for 6 repositories.*mobile-app-ios/);
    expect(report.findings.some((f: any) => /deploy/i.test(f.title) && f.repositoryId === "mobile-app-ios")).toBe(false);

    // Hypotheses never drive recommendations.
    const recFindingIds = report.recommendations.flatMap((r: any) => r.findingIds);
    expect(recFindingIds).not.toContain(hyp.id);
    expect(report.agentSummaries.map((a: any) => a.agentId)).toEqual(["github", "project", "bug", "devops", "review"]);
    expect(report.warnings.join(" ")).toMatch(/labelled demo fixture dataset/);
  });

  it("marks the investigation partial when one agent crashes, keeping the other agents' results", async () => {
    const broken: Agent = { id: "devops", run: async () => { throw new Error("boom"); } };
    const { inv, events, report } = await run({ agents: { specialists: { ...SPECIALIST_AGENTS, devops: broken }, review: REVIEW_AGENT } });
    expect(inv.status).toBe("partial");
    expect(inv.agentStatuses).toMatchObject({ devops: "failed", github: "completed", bug: "completed" });
    expect(events.some((e: any) => e.agentId === "devops" && e.eventType === "agent.failed")).toBe(true);
    expect(events.at(-1).eventType).toBe("investigation.partial");
    expect(report.status).toBe("partial");
    expect(byId(report, "bug:critical:mobile-payments-sdk")).toBeTruthy();
    expect(report.findings.some((f: any) => f.agentId === "devops")).toBe(false);
    expect(report.unavailableData.join(" ")).toMatch(/devops analysis unavailable \(AGENT_ERROR\)/);
    expect(inv.errorSummary).toMatch(/did not complete/);
  });

  it("times out a slow agent without blocking the investigation", async () => {
    const slow: Agent = { id: "bug", run: () => new Promise(() => {}) };
    const { inv, report } = await run({ env: { AGENT_TIMEOUT_MS: "50" }, agents: { specialists: { ...SPECIALIST_AGENTS, bug: slow }, review: REVIEW_AGENT } });
    expect(inv.status).toBe("partial");
    expect(inv.agentStatuses.bug).toBe("failed");
    expect(report.unavailableData.join(" ")).toMatch(/bug analysis unavailable \(TIMEOUT\)/);
  });

  it("the Review agent's AI can only downgrade inferences, never facts, and ignores unknown ids", async () => {
    const gemini = scriptedGemini(({ purpose }) => {
      if (purpose === "review") return { flags: [
        { findingId: "project:health:demo_ios_app", issue: "Overstates certainty." },
        { findingId: "bug:critical:mobile-payments-sdk", issue: "Try to downgrade a fact." },
        { findingId: "invented", issue: "Unknown." },
      ] };
      if (purpose === "plan") return { agents: ["github", "project", "bug", "devops"], rationale: "All." };
      if (purpose === "synthesis") return { executiveSummary: "Summary.", recommendations: [] };
      return { summary: "Summary." };
    });
    const { report } = await run({ gemini, env: { MAX_MODEL_CALLS_PER_INVESTIGATION: "10" } });
    expect(byId(report, "project:health:demo_ios_app")).toMatchObject({ verification: "unverified" });
    expect(byId(report, "project:health:demo_ios_app").reviewNotes.join()).toMatch(/AI review: Overstates certainty/);
    expect(byId(report, "bug:critical:mobile-payments-sdk").verification).toBe("verified");
    expect(report.warnings.join(" ")).toMatch(/AI flags for unknown findings were ignored/);
    expect(report.budgets.modelCallsUsed).toBeLessThanOrEqual(10);
  });
});

describe("Phase 5: incidents", () => {
  it("CRUD, investigation linked to the incident, incident cited as evidence", async () => {
    const { app, ctx } = await makeApp();
    const list = await request(app).get("/api/v1/incidents?organizationId=org_demo").set(auth(VIEWER));
    expect(list.body.data.map((i: any) => i.id)).toContain("demo_incident_payments");
    const created = await request(app).post("/api/v1/incidents").set(auth(OWNER))
      .send({ organizationId: "org_demo", projectId: "demo_auth_service", title: "Token refresh errors", severity: "sev2" });
    expect(created.status).toBe(201);
    expect((await request(app).post("/api/v1/incidents").set(auth(OWNER)).send({ organizationId: "org_demo", projectId: "nope", title: "X happened", severity: "sev2" })).status).toBe(400);
    expect((await request(app).patch(`/api/v1/incidents/${created.body.data.id}`).set(auth(VIEWER)).send({ status: "resolved" })).status).toBe(403);

    const inv = await request(app).post("/api/v1/incidents/demo_incident_payments/investigate").set(auth(OWNER));
    expect(inv.status).toBe(202);
    const id = inv.body.data.investigationId;
    await ctx.investigations.waitFor(id);
    const incident = (await request(app).get("/api/v1/incidents/demo_incident_payments").set(auth(OWNER))).body.data;
    expect(incident.investigationIds).toEqual([id]);
    const report = (await request(app).get(`/api/v1/reports/${id}`).set(auth(OWNER))).body.data;
    const fact = report.findings.find((f: any) => f.id === "incident:demo_incident_payments");
    expect(fact).toMatchObject({ kind: "fact", severity: "critical", verification: "verified" });
    expect(fact.evidence[0].sourceId).toBe("incident:demo_incident_payments");
    // Scoped to the incident's project: only its repository was analysed.
    const repos = new Set(report.findings.map((f: any) => f.repositoryId).filter(Boolean));
    expect([...repos]).toEqual(["mobile-payments-sdk"]);
    expect(report.health.projects.map((p: any) => p.projectId)).toEqual(["demo_payments_sdk"]);
  });

  it("report endpoint returns 409 until the investigation finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const gated: Agent = { id: "github", run: async (c) => { await gate; return SPECIALIST_AGENTS.github!.run(c); } };
    const { app, ctx } = await makeApp({ agents: { specialists: { ...SPECIALIST_AGENTS, github: gated }, review: REVIEW_AGENT } });
    const res = await request(app).post("/api/v1/agents/investigations").set(auth(OWNER)).send({ organizationId: "org_demo", query: "health?" });
    const early = await request(app).get(`/api/v1/reports/${res.body.data.investigationId}`).set(auth(OWNER));
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("REPORT_NOT_READY");
    release();
    await ctx.investigations.waitFor(res.body.data.investigationId);
    expect((await request(app).get(`/api/v1/reports/${res.body.data.investigationId}`).set(auth(OWNER))).status).toBe(200);
    const listed = await request(app).get("/api/v1/agents/investigations?organizationId=org_demo").set(auth(VIEWER));
    expect(listed.body.data[0]).toMatchObject({ hasReport: true });
    expect(listed.body.data[0].finalReport).toBeUndefined();
  });
});

describe("restart recovery", () => {
  it("marks investigations left running by a previous process as failed, with a terminal event", async () => {
    const { ctx } = await makeApp();
    await ctx.store.investigations.create({ id: "inv_orphan", organizationId: "org_demo", requestedBy: OWNER, query: "q", scope: { projectIds: [], repositoryIds: [] },
      incidentId: null, status: "running", createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), completedAt: null, agentStatuses: {},
      plan: null, finalReport: null, warnings: [], errorSummary: null, eventCount: 0, modelCallsUsed: 0, toolCallsUsed: 0, idempotencyKey: null });
    expect(await ctx.investigations.recoverInterrupted()).toBe(1);
    const inv = await ctx.store.investigations.get("inv_orphan");
    expect(inv).toMatchObject({ status: "failed", errorSummary: expect.stringMatching(/server restart/) });
    expect((await ctx.store.events.list("inv_orphan", 0, 10)).at(-1)!.eventType).toBe("investigation.failed");
    expect(await ctx.investigations.recoverInterrupted()).toBe(0);
  });
});
