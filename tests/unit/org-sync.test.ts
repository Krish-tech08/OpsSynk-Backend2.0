import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../../src/repositories/memory.store.js";
import { seedDemo, syncOrganization } from "../../src/demo/seed.js";
import { DEMO_ORG_ID, ORG_INCIDENTS, ORG_PROJECTS } from "../../src/demo/demo-dataset.js";

const base = { ownerUid: "owner", githubOrganization: "SynkStack", now: new Date("2026-11-07T00:00:00Z") };
const sync = (store: ReturnType<typeof createMemoryStore>) =>
  syncOrganization(store, { ...base, projects: ORG_PROJECTS, incidents: ORG_INCIDENTS });

describe("syncOrganization", () => {
  it("replaces the synthetic projects with the configured repositories and is a no-op afterwards", async () => {
    const store = createMemoryStore();
    await seedDemo(store, base);
    await store.projects.upsert({ ...(await store.projects.get("demo_ios_app"))!, id: "user_project", isDemoData: false });

    const first = await sync(store);
    expect(first.seeded).not.toBeNull();
    const ids = (await store.projects.list(DEMO_ORG_ID)).map((p) => p.id).sort();
    expect(ids).toEqual([...ORG_PROJECTS.map((p) => p.id), "user_project"].sort());
    expect((await store.projects.get("synk_fieldtrack"))!.repositoryIds).toEqual(["mobile-fieldtrack"]);
    expect(await store.tasks.listByProject("demo_ios_app")).toEqual([]);
    expect((await store.tasks.listByProject("synk_authcore")).length).toBe(5);
    expect((await store.incidents.list(DEMO_ORG_ID)).map((i) => i.id).sort()).toEqual(ORG_INCIDENTS.map((i) => i.id).sort());
    expect((await store.members.get(DEMO_ORG_ID, "owner"))!.role).toBe("owner");

    expect(await sync(store)).toEqual({ removed: 0, seeded: null });
  });

  it("seeds an empty store", async () => {
    const store = createMemoryStore();
    const r = await sync(store);
    expect(r.removed).toBe(0);
    expect((await store.organizations.get(DEMO_ORG_ID))!.name).toBe("SynkStack");
    expect((await store.projects.list(DEMO_ORG_ID)).length).toBe(ORG_PROJECTS.length);
  });
});
