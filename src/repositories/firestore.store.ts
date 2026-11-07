import type { Firestore } from "firebase-admin/firestore";
import type { Store, NewEvent } from "./store.js";
import type { InvestigationEvent } from "../types/investigation.js";

/**
 * Firestore-backed Store.
 * Layout:
 *   organizations/{orgId}                     organizations/{orgId}/members/{uid}
 *   projects/{id}  tasks/{id}  incidents/{id}  engineeringSnapshots/{id}
 *   investigations/{id}                       investigations/{id}/events/{sequence padded to 6 digits}
 * Event sequence numbers are assigned in a transaction against investigations/{id}.eventCount,
 * so concurrent agents never produce duplicate or out-of-order sequence numbers.
 */
export function createFirestoreStore(db: Firestore): Store {
  const data = <T>(snap: FirebaseFirestore.DocumentSnapshot): T | null => (snap.exists ? (snap.data() as T) : null);
  const byOrg = async <T>(col: string, orgId: string) =>
    (await db.collection(col).where("organizationId", "==", orgId).get()).docs.map((d) => d.data() as T);

  return {
    kind: "firestore",
    organizations: {
      get: async (id) => data(await db.collection("organizations").doc(id).get()),
      upsert: async (o) => void (await db.collection("organizations").doc(o.id).set(o)),
    },
    members: {
      get: async (orgId, uid) => data(await db.collection("organizations").doc(orgId).collection("members").doc(uid).get()),
      upsert: async (m) => void (await db.collection("organizations").doc(m.organizationId).collection("members").doc(m.uid).set(m)),
    },
    projects: {
      list: (orgId) => byOrg("projects", orgId),
      get: async (id) => data(await db.collection("projects").doc(id).get()),
      upsert: async (p) => void (await db.collection("projects").doc(p.id).set(p)),
      remove: async (id) => void (await db.collection("projects").doc(id).delete()),
    },
    tasks: {
      listByProject: async (pid) => (await db.collection("tasks").where("projectId", "==", pid).get()).docs.map((d) => d.data() as any),
      get: async (id) => data(await db.collection("tasks").doc(id).get()),
      upsert: async (t) => void (await db.collection("tasks").doc(t.id).set(t)),
      remove: async (id) => void (await db.collection("tasks").doc(id).delete()),
    },
    incidents: {
      list: (orgId) => byOrg("incidents", orgId),
      get: async (id) => data(await db.collection("incidents").doc(id).get()),
      upsert: async (i) => void (await db.collection("incidents").doc(i.id).set(i)),
      remove: async (id) => void (await db.collection("incidents").doc(id).delete()),
    },
    investigations: {
      create: async (inv) => void (await db.collection("investigations").doc(inv.id).create(inv)),
      get: async (id) => data(await db.collection("investigations").doc(id).get()),
      list: async (orgId, limit) =>
        (await db.collection("investigations").where("organizationId", "==", orgId).orderBy("createdAt", "desc").limit(limit).get())
          .docs.map((d) => d.data() as any),
      update: async (id, patch) => void (await db.collection("investigations").doc(id).update(patch as any)),
      listActive: async (limit) =>
        (await db.collection("investigations").where("status", "in", ["queued", "running"]).limit(limit).get()).docs.map((d) => d.data() as any),
      findByIdempotencyKey: async (orgId, uid, key) => {
        const q = await db.collection("investigations").where("organizationId", "==", orgId)
          .where("requestedBy", "==", uid).where("idempotencyKey", "==", key).limit(1).get();
        return q.empty ? null : (q.docs[0].data() as any);
      },
    },
    events: {
      append: async (e: NewEvent) => {
        const invRef = db.collection("investigations").doc(e.investigationId);
        return db.runTransaction(async (tx) => {
          const inv = await tx.get(invRef);
          const sequence = ((inv.get("eventCount") as number | undefined) ?? 0) + 1;
          const ev: InvestigationEvent = { ...e, id: `${e.investigationId}_${sequence}`, sequence };
          tx.set(invRef.collection("events").doc(String(sequence).padStart(6, "0")), ev);
          tx.update(invRef, { eventCount: sequence });
          return ev;
        });
      },
      list: async (invId, after, limit) =>
        (await db.collection("investigations").doc(invId).collection("events")
          .where("sequence", ">", after).orderBy("sequence").limit(limit).get()).docs.map((d) => d.data() as InvestigationEvent),
    },
    snapshots: {
      upsert: async (s) => void (await db.collection("engineeringSnapshots").doc(s.id).set(s)),
      listByOrganization: async (orgId, limit) =>
        (await db.collection("engineeringSnapshots").where("organizationId", "==", orgId).orderBy("capturedAt", "desc").limit(limit).get())
          .docs.map((d) => d.data() as any),
    },
  };
}
