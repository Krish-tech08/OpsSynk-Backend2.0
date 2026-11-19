import { describe, expect, it } from "vitest";
import request from "supertest";
import { auth, makeApp, OUTSIDER, OWNER, VIEWER } from "../helpers/setup.js";

describe("meta routes", () => {
  it("GET /version returns build info without auth and without secrets", async () => {
    const { app } = await makeApp();
    const r = await request(app).get("/version");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: "opssynk-backend", version: expect.any(String), node: process.version });
    expect(r.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(r.body)).not.toMatch(/token|key|secret/i);
  });

  it("GET /organizations/:id/me returns the caller's role", async () => {
    const { app } = await makeApp();
    const owner = await request(app).get("/api/v1/organizations/org_demo/me").set(auth(OWNER));
    expect(owner.status).toBe(200);
    expect(owner.body).toMatchObject({ success: true, data: { uid: OWNER, organizationId: "org_demo", role: "owner" } });
    const viewer = await request(app).get("/api/v1/organizations/org_demo/me").set(auth(VIEWER));
    expect(viewer.body.data.role).toBe("viewer");
  });

  it("GET /organizations/:id/me hides the organization from non-members and needs a token", async () => {
    const { app } = await makeApp();
    expect((await request(app).get("/api/v1/organizations/org_demo/me").set(auth(OUTSIDER))).status).toBe(404);
    expect((await request(app).get("/api/v1/organizations/org_demo/me")).status).toBe(401);
  });

  it("GET /organizations/:id/me rejects invalid organization ids", async () => {
    const { app } = await makeApp();
    const r = await request(app).get("/api/v1/organizations/bad%20id/me").set(auth(OWNER));
    expect(r.status).toBe(400);
  });
});