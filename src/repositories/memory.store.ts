import type { Store, NewEvent } from "./store.js";
import type { InvestigationEvent } from "../types/investigation.js";

const clone = <T>(v: T): T => structuredClone(v);

/** In-memory Store for tests and local development. Not durable. */
export function createMemoryStore(): Store {
  const orgs = new Map<string, any>();
  const members = new Map<string, any>();
  const projects = new Map<string, any>();
  const tasks = new Map<string, any>();
  const incidents = new Map<string, any>();
  const investigations = new Map<string, any>();
  const events = new Map<string, InvestigationEvent[]>();
  const snapshots = new Map<string, any>();

  return {
    kind: "memory",
    organizations: {
      get: async (id) => clone(orgs.get(id) ?? null),
      upsert: async (o) => void orgs.set(o.id, clone(o)),
    },
    members: {
      get: async (orgId, uid) => clone(members.get(`${orgId}/${uid}`) ?? null),
      upsert: async (m) => void members.set(`${m.organizationId}/${m.uid}`, clone(m)),
    },
    projects: {
      list: async (orgId) => [...projects.values()].filter((p) => p.organizationId === orgId).map(clone),
      get: async (id) => clone(projects.get(id) ?? null),
      upsert: async (p) => void projects.set(p.id, clone(p)),
      remove: async (id) => void projects.delete(id),
    },
    tasks: {
      listByProject: async (pid) => [...tasks.values()].filter((t) => t.projectId === pid).map(clone),
      get: async (id) => clone(tasks.get(id) ?? null),
      upsert: async (t) => void tasks.set(t.id, clone(t)),
      remove: async (id) => void tasks.delete(id),
    },
    incidents: {
      list: async (orgId) => [...incidents.values()].filter((i) => i.organizationId === orgId).map(clone),
      get: async (id) => clone(incidents.get(id) ?? null),
      upsert: async (i) => void incidents.set(i.id, clone(i)),
      remove: async (id) => void incidents.delete(id),
    },
    investigations: {
      create: async (inv) => {
        if (investigations.has(inv.id)) throw new Error(`Investigation ${inv.id} exists`);
        investigations.set(inv.id, clone(inv));
      },
      get: async (id) => clone(investigations.get(id) ?? null),
      list: async (orgId, limit) =>
        [...investigations.values()]
          .filter((i) => i.organizationId === orgId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, limit)
          .map(clone),
      update: async (id, patch) => {
        const cur = investigations.get(id);
        if (!cur) throw new Error(`Investigation ${id} not found`);
        investigations.set(id, { ...cur, ...clone(patch) });
      },
      listActive: async (limit) => [...investigations.values()].filter((i) => i.status === "queued" || i.status === "running").slice(0, limit).map(clone),
      findByIdempotencyKey: async (orgId, uid, key) =>
        clone([...investigations.values()].find((i) => i.organizationId === orgId && i.requestedBy === uid && i.idempotencyKey === key) ?? null),
    },
    events: {
      append: async (e: NewEvent) => {
        const list = events.get(e.investigationId) ?? [];
        const sequence = list.length + 1;
        const ev: InvestigationEvent = { ...clone(e), id: `${e.investigationId}_${sequence}`, sequence };
        list.push(ev);
        events.set(e.investigationId, list);
        const inv = investigations.get(e.investigationId);
        if (inv) inv.eventCount = sequence;
        return clone(ev);
      },
      list: async (invId, after, limit) => (events.get(invId) ?? []).filter((e) => e.sequence > after).slice(0, limit).map(clone),
    },
    snapshots: {
      upsert: async (s) => void snapshots.set(s.id, clone(s)),
      listByOrganization: async (orgId, limit) =>
        [...snapshots.values()].filter((s) => s.organizationId === orgId)
          .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)).slice(0, limit).map(clone),
    },
  };
}
