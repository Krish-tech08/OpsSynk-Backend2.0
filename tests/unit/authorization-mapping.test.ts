import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../../src/repositories/memory.store.js";
import { authorizeResource, requireOrgRole } from "../../src/services/authorization.service.js";
import { validateRepositoryMapping } from "../../src/domain/health/repository-mapping.js";
import type { RepoSummary } from "../../src/integrations/github/github.types.js";

describe("organization-scoped authorization", () => {
  const setup = async () => {
    const store = createMemoryStore();
    for (const [uid, role] of [["v", "viewer"], ["m", "member"], ["a", "admin"], ["o", "owner"]] as const)
      await store.members.upsert({ uid, organizationId: "org1", role, createdAt: "2026-01-01T00:00:00Z" });
    await store.members.upsert({ uid: "x", organizationId: "org2", role: "owner", createdAt: "2026-01-01T00:00:00Z" });
    return store;
  };
  it("enforces the role hierarchy viewer < member < admin < owner", async () => {
    const store = await setup();
    await expect(requireOrgRole(store, "v", "org1", "viewer")).resolves.toMatchObject({ role: "viewer" });
    await expect(requireOrgRole(store, "v", "org1", "member")).rejects.toMatchObject({ code: "FORBIDDEN", httpStatus: 403 });
    await expect(requireOrgRole(store, "m", "org1", "member")).resolves.toBeTruthy();
    await expect(requireOrgRole(store, "m", "org1", "admin")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(requireOrgRole(store, "o", "org1", "admin")).resolves.toBeTruthy();
  });
  it("roles are per organization: an owner elsewhere is a non-member here (404, existence not revealed)", async () => {
    const store = await setup();
    await expect(requireOrgRole(store, "x", "org1", "viewer")).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
  });
  it("resources from another organization look like missing resources", async () => {
    const store = await setup();
    await expect(authorizeResource(store, "x", { organizationId: "org1" }, "Project", "viewer")).rejects.toMatchObject({ httpStatus: 404 });
    await expect(authorizeResource(store, "v", null, "Project", "viewer")).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe("repository mapping validation", () => {
  const repo = (id: string, archived = false): RepoSummary => ({ id, fullName: `org/${id}`, owner: "org", url: "", description: null, defaultBranch: "main", private: false, archived, pushedAt: null });
  const available = [repo("api"), repo("web"), repo("legacy", true)];
  it("accepts repositories that exist in the organization", () => {
    expect(validateRepositoryMapping(["api", "web"], available, [])).toEqual({ valid: ["api", "web"], invalid: [] });
  });
  it("rejects unknown, archived, duplicate, malformed and non-allowlisted repositories with reasons", () => {
    const r = validateRepositoryMapping(["api", "ghost", "legacy", "api", "../etc", "web"], available, ["api", "legacy", "ghost"]);
    expect(r.valid).toEqual(["api"]);
    expect(r.invalid).toEqual([
      { repositoryId: "ghost", reason: "not_found_in_organization" },
      { repositoryId: "legacy", reason: "archived" },
      { repositoryId: "api", reason: "duplicate" },
      { repositoryId: "../etc", reason: "invalid_format" },
      { repositoryId: "web", reason: "not_in_allowlist" },
    ]);
  });
});
