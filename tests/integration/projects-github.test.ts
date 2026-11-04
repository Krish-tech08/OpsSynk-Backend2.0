import { describe, expect, it } from "vitest";
import request from "supertest";
import { auth, makeApp, OWNER, VIEWER } from "../helpers/setup.js";
import type { GitHubTransport } from "../../src/integrations/github/github.client.js";
import { Errors } from "../../src/utils/errors.js";

describe("Phase 2: projects, tasks and repository mapping", () => {
  it("creates a project only with repositories that exist in the organization", async () => {
    const { app } = await makeApp();
    const bad = await request(app).post("/api/v1/projects").set(auth(OWNER))
      .send({ organizationId: "org_demo", name: "New", repositoryIds: ["mobile-app-ios", "does-not-exist"] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ code: "INVALID_REPOSITORY_MAPPING", details: [{ repositoryId: "does-not-exist", reason: "not_found_in_organization" }] });
    const good = await request(app).post("/api/v1/projects").set(auth(OWNER))
      .send({ organizationId: "org_demo", name: "New", repositoryIds: ["mobile-app-ios"], startDate: "2026-10-01", dueDate: "2026-12-01" });
    expect(good.status).toBe(201);
    expect(good.body.data).toMatchObject({ name: "New", repositoryIds: ["mobile-app-ios"], status: "planning" });
    const patch = await request(app).patch(`/api/v1/projects/${good.body.data.id}`).set(auth(OWNER)).send({ repositoryIds: ["ghost"] });
    expect(patch.status).toBe(400);
    const dates = await request(app).patch(`/api/v1/projects/${good.body.data.id}`).set(auth(OWNER)).send({ dueDate: "2026-09-01" });
    expect(dates.status).toBe(400);
  });

  it("refuses to save a mapping when GitHub can't validate it", async () => {
    const down: GitHubTransport = { source: "github", getJson: async () => { throw Errors.githubUnavailable(); },
      getPaginated: async () => { throw Errors.githubUnavailable(); }, rateLimit: () => ({ remaining: null, resetAt: null }) };
    const { app } = await makeApp({ transport: down });
    const r = await request(app).post("/api/v1/projects").set(auth(OWNER)).send({ organizationId: "org_demo", name: "X", repositoryIds: ["api"] });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("MAPPING_VALIDATION_UNAVAILABLE");
  });

  it("task CRUD with authorization", async () => {
    const { app } = await makeApp();
    const created = await request(app).post("/api/v1/projects/demo_ios_app/tasks").set(auth(OWNER)).send({ title: "Write tests", dueDate: "2026-11-01" });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    expect((await request(app).patch(`/api/v1/tasks/${id}`).set(auth(OWNER)).send({ status: "done" })).body.data.status).toBe("done");
    expect((await request(app).get(`/api/v1/tasks/${id}`).set(auth(VIEWER))).status).toBe(200);
    expect((await request(app).patch(`/api/v1/tasks/${id}`).set(auth(VIEWER)).send({ status: "todo" })).status).toBe(403);
    const list = await request(app).get("/api/v1/projects/demo_ios_app/tasks?limit=2").set(auth(OWNER));
    expect(list.body.data).toHaveLength(2);
    expect(list.body.meta.nextCursor).toBeTruthy();
  });
});

describe("Phase 2: GitHub endpoints and deterministic health", () => {
  it("issues exclude PRs; pulls carry stale flags; responses are labelled as fixture data", async () => {
    const { app } = await makeApp();
    const issues = await request(app).get("/api/v1/github/repositories/mobile-app-ios/issues?organizationId=org_demo").set(auth(OWNER));
    expect(issues.body.data.map((i: any) => i.number)).toEqual([201, 202, 203]);
    expect(issues.body.meta).toMatchObject({ pullRequestsExcluded: 3, dataSource: "fixture", isDemoData: true });
    const pulls = await request(app).get("/api/v1/github/repositories/mobile-app-ios/pulls?organizationId=org_demo").set(auth(OWNER));
    expect(pulls.body.data.filter((p: any) => p.stale).map((p: any) => p.number)).toEqual([17, 18]);
    expect(pulls.body.data[0].url).toMatch(/^https:\/\/fixtures\.opssynk\.invalid\//);
    expect((await request(app).get("/api/v1/github/repositories/unknown/pulls?organizationId=org_demo").set(auth(OWNER))).status).toBe(404);
  });

  it("repository summary reports deployment evidence honestly", async () => {
    const { app } = await makeApp();
    const ios = await request(app).get("/api/v1/github/repositories/mobile-app-ios?organizationId=org_demo").set(auth(OWNER));
    expect(ios.body.data.summary.deployments).toBe("no_deployment_data");
    const pay = await request(app).get("/api/v1/github/repositories/mobile-payments-sdk?organizationId=org_demo").set(auth(OWNER));
    expect(pay.body.data.summary.deployments[0].latestStatus.state).toBe("failure");
  });

  it("sync writes one snapshot per mapped repository per hour (safe to retry)", async () => {
    const { app, ctx } = await makeApp();
    const a = await request(app).post("/api/v1/github/sync?organizationId=org_demo").set(auth(OWNER));
    const b = await request(app).post("/api/v1/github/sync?organizationId=org_demo").set(auth(OWNER));
    expect(a.status).toBe(200);
    expect(a.body.data.snapshotIds).toEqual(b.body.data.snapshotIds);
    expect((await ctx.store.snapshots.listByOrganization("org_demo", 100))).toHaveLength(12);
    expect((await request(app).post("/api/v1/github/sync?organizationId=org_demo").set(auth(VIEWER))).status).toBe(403);
  });

  it("company analytics: identifies the critical and warning demo projects with transparent sub-scores", async () => {
    const { app } = await makeApp();
    const r = await request(app).get("/api/v1/analytics/projects?organizationId=org_demo").set(auth(OWNER));
    const byId = Object.fromEntries(r.body.data.map((p: any) => [p.projectId, p]));
    expect(byId.demo_payments_sdk.status).toBe("critical");
    expect(byId.demo_chat_bot.status).toBe("critical");
    expect(byId.demo_ios_app.status).toBe("warning");
    expect(byId.demo_auth_service.status).toBe("warning");
    expect(byId.demo_android_app.status).toBe("healthy");
    const counts = r.body.data.reduce((a: any, p: any) => ({ ...a, [p.status]: (a[p.status] ?? 0) + 1 }), {});
    expect(counts).toEqual({ healthy: 5, warning: 4, critical: 3 });
    expect(byId.demo_ios_app.subScores.map((s: any) => s.category)).toEqual(["delivery", "ci", "bugs", "pullRequests", "activity"]);
    expect(byId.demo_ios_app.evidence.stalePullRequests.map((p: any) => p.number)).toEqual([17, 18]);
    const company = await request(app).get("/api/v1/analytics/company?organizationId=org_demo").set(auth(VIEWER));
    expect(company.body.data).toMatchObject({ coverage: 1, containsDemoData: true, dataSource: "fixture", projectCounts: { critical: 3, warning: 4, healthy: 5 } });
    expect(company.body.data.weights).toEqual({ delivery: 0.3, ci: 0.25, bugs: 0.2, pullRequests: 0.15, activity: 0.1 });
    const summary = await request(app).get("/api/v1/health/summary?organizationId=org_demo").set(auth(VIEWER));
    expect(summary.body.data.score).toBe(company.body.data.score);
  });

  it("a project without repositories or tasks reports insufficient data instead of a zero score", async () => {
    const { app } = await makeApp();
    const p = await request(app).post("/api/v1/projects").set(auth(OWNER)).send({ organizationId: "org_demo", name: "Empty" });
    const h = await request(app).get(`/api/v1/projects/${p.body.data.id}/health`).set(auth(OWNER));
    expect(h.body.data).toMatchObject({ score: null, status: "insufficient_data", coverage: 0 });
    expect(h.body.data.subScores.every((s: any) => s.score === null && s.reason)).toBe(true);
  });
});

describe("one clock", () => {
  it("routes judge staleness with the injected clock, not the machine's date", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["src/routes/github.routes.ts", "src/routes/health.routes.ts", "src/routes/agents.routes.ts", "src/routes/analytics.routes.ts"])
      expect(readFileSync(f, "utf8"), f).not.toMatch(/new Date\(\)/);
  });
});
