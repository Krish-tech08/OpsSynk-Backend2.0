import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../../src/repositories/memory.store.js";
import type { Store } from "../../src/repositories/store.js";

/**
 * Store contract. Always runs against the in-memory store. To run it against Firestore too, start the
 * emulator (firebase emulators:start --only firestore) and set FIRESTORE_EMULATOR_HOST=127.0.0.1:8080.
 */
const stores: Array<[string, () => Promise<Store>]> = [["memory", async () => createMemoryStore()]];
if (process.env.FIRESTORE_EMULATOR_HOST) stores.push(["firestore-emulator", async () => {
  const { initializeApp, getApps } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const { createFirestoreStore } = await import("../../src/repositories/firestore.store.js");
  const app = getApps()[0] ?? initializeApp({ projectId: "demo-opssynk-test" });
  return createFirestoreStore(getFirestore(app));
}]);

describe.each(stores)("Store contract (%s)", (_name, make) => {
  it("assigns gap-free event sequence numbers under concurrent appends", async () => {
    const store = await make();
    const id = `inv_contract_${Date.now()}`;
    await store.investigations.create({ id, organizationId: "o", requestedBy: "u", query: "q", scope: { projectIds: [], repositoryIds: [] }, incidentId: null,
      status: "queued", createdAt: new Date().toISOString(), startedAt: null, completedAt: null, agentStatuses: {}, plan: null, finalReport: null,
      warnings: [], errorSummary: null, eventCount: 0, modelCallsUsed: 0, toolCallsUsed: 0, idempotencyKey: "k" });
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.events.append({ investigationId: id, agentId: null, eventType: "tool.started",
      message: `e${i}`, status: "info", timestamp: new Date().toISOString(), metadata: {} })));
    const events = await store.events.list(id, 0, 100);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect((await store.events.list(id, 7, 100)).map((e) => e.sequence)).toEqual([8, 9, 10]);
    expect((await store.investigations.get(id))!.eventCount).toBe(10);
    expect((await store.investigations.findByIdempotencyKey("o", "u", "k"))!.id).toBe(id);
  });
  it("keeps memberships scoped to their organization", async () => {
    const store = await make();
    await store.members.upsert({ uid: "u1", organizationId: "orgA", role: "admin", createdAt: new Date().toISOString() });
    expect((await store.members.get("orgA", "u1"))!.role).toBe("admin");
    expect(await store.members.get("orgB", "u1")).toBeNull();
  });
});
