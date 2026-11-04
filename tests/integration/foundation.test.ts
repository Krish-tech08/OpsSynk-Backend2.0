import { describe, expect, it } from "vitest";
import request from "supertest";
import { auth, makeApp, OUTSIDER, OWNER, VIEWER } from "../helpers/setup.js";

describe("Phase 1: foundation", () => {
  it("liveness and readiness expose modes but no secrets", async () => {
    const { app } = await makeApp();
    expect((await request(app).get("/health")).body).toEqual({ status: "ok" });
    const r = await request(app).get("/ready");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "ready", checks: { storage: "ok", github: "degraded", gemini: "not_configured" },
      modes: { storage: "memory", githubData: "fixture" } });
    expect(JSON.stringify(r.body)).not.toMatch(/token|key|secret/i);
  });

  it("requires a valid bearer token", async () => {
    const { app } = await makeApp();
    const none = await request(app).get("/api/v1/projects?organizationId=org_demo");
    expect(none.status).toBe(401);
    expect(none.body).toMatchObject({ success: false, error: { code: "UNAUTHENTICATED" } });
    expect(none.body.error.requestId).toMatch(/^req_/);
    expect((await request(app).get("/api/v1/projects?organizationId=org_demo").set("Authorization", "Bearer forged")).status).toBe(401);
  });

  it("enforces organization membership (404) and roles (403)", async () => {
    const { app } = await makeApp();
    expect((await request(app).get("/api/v1/projects?organizationId=org_demo").set(auth(OUTSIDER))).status).toBe(404);
    expect((await request(app).get("/api/v1/projects/demo_ios_app").set(auth(OUTSIDER))).status).toBe(404);
    expect((await request(app).get("/api/v1/projects?organizationId=org_demo").set(auth(VIEWER))).status).toBe(200);
    const write = await request(app).post("/api/v1/projects").set(auth(VIEWER)).send({ organizationId: "org_demo", name: "X" });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe("FORBIDDEN");
  });

  it("validates input and never leaks internals", async () => {
    const { app } = await makeApp();
    const bad = await request(app).post("/api/v1/projects").set(auth(OWNER)).send({ organizationId: "org_demo", name: "" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_FAILED");
    expect(bad.body.error.details[0].path).toBe("name");
    const json = await request(app).post("/api/v1/projects").set(auth(OWNER)).set("Content-Type", "application/json").send("{oops");
    expect(json.status).toBe(400);
    expect(json.body.error.code).toBe("INVALID_JSON");
    expect(JSON.stringify(json.body)).not.toMatch(/at .*\.ts|stack/i);
    expect((await request(app).get("/api/v1/nope").set(auth(OWNER))).status).toBe(404);
  });

  it("CORS: none by default; only configured browser origins; native clients unaffected", async () => {
    const closed = (await makeApp()).app;
    const r1 = await request(closed).get("/health").set("Origin", "https://evil.example");
    expect(r1.headers["access-control-allow-origin"]).toBeUndefined();
    const open = (await makeApp({ env: { CORS_ORIGINS: "https://dashboard.opssynk.dev" } })).app;
    const ok = await request(open).get("/health").set("Origin", "https://dashboard.opssynk.dev");
    expect(ok.headers["access-control-allow-origin"]).toBe("https://dashboard.opssynk.dev");
    const pre = await request(open).options("/api/v1/projects").set("Origin", "https://dashboard.opssynk.dev").set("Access-Control-Request-Method", "POST");
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-headers"]).toMatch(/Authorization/);
    expect((await request(open).options("/api/v1/projects").set("Origin", "https://evil.example")).status).toBe(403);
    const native = await request(open).get("/health");                // Android: no Origin header
    expect(native.status).toBe(200);
    expect(native.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rate-limits AI investigation creation", async () => {
    const { app } = await makeApp({ env: { INVESTIGATION_RATE_LIMIT: "1", ENABLED_AGENTS: "manager" } });
    const body = { organizationId: "org_demo", query: "health please" };
    expect((await request(app).post("/api/v1/agents/investigations").set(auth(OWNER)).send(body)).status).toBe(202);
    const second = await request(app).post("/api/v1/agents/investigations").set(auth(OWNER)).send({ ...body, query: "another one" });
    expect(second.status).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();
  });
});

describe("Firestore document ID rules", () => {
  it("never uses reserved __name__ document IDs", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]);
    for (const f of walk("src").filter((x) => x.endsWith(".ts")))
      expect(readFileSync(f, "utf8"), f).not.toMatch(/\.(get|doc)\(\s*["'`]__\w+__["'`]/);
  });
});
