import type { Store } from "../repositories/store.js";
import type { Incident, Organization, Project, Task } from "../types/domain.js";
import { DEMO_INCIDENTS, DEMO_ORG_ID, DEMO_PROJECTS, DEMO_TASKS } from "./demo-dataset.js";
import { DAY_MS } from "../utils/time.js";

export interface SeedOptions {
  ownerUid: string;
  githubOrganization: string;
  now: Date;
  viewerUid?: string;
}
export interface SeedReport { written: number; skippedNonDemo: string[] }

/**
 * Idempotent demo seeding. Every record has a fixed ID and isDemoData: true.
 * Existing documents that are NOT demo data are never overwritten; they are reported instead.
 */
export async function seedDemo(store: Store, o: SeedOptions): Promise<SeedReport> {
  const report: SeedReport = { written: 0, skippedNonDemo: [] };
  const at = (days: number) => new Date(o.now.getTime() + days * DAY_MS).toISOString();
  const ts = o.now.toISOString();

  async function put<T extends { id?: string; isDemoData?: boolean }>(kind: string, existing: T | null, write: () => Promise<void>, key: string) {
    if (existing && !existing.isDemoData) { report.skippedNonDemo.push(`${kind}:${key}`); return; }
    await write();
    report.written++;
  }

  const org: Organization = { id: DEMO_ORG_ID, name: "OpsSynk Demo Company", githubOrganization: o.githubOrganization, ownerUid: o.ownerUid, createdAt: ts, isDemoData: true };
  await put("organization", await store.organizations.get(org.id), () => store.organizations.upsert(org), org.id);

  const members = [{ uid: o.ownerUid, role: "owner" as const }, ...(o.viewerUid ? [{ uid: o.viewerUid, role: "viewer" as const }] : [])];
  for (const m of members)
    await put("member", await store.members.get(DEMO_ORG_ID, m.uid),
      () => store.members.upsert({ uid: m.uid, organizationId: DEMO_ORG_ID, role: m.role, createdAt: ts, isDemoData: true }), m.uid);

  const dueBy = { healthy: 30, warning: 10, critical: -2 } as const;
  for (const p of DEMO_PROJECTS) {
    const project: Project = {
      id: p.id, organizationId: DEMO_ORG_ID, name: p.name, description: p.description, teamId: p.team.toLowerCase(),
      repositoryIds: [p.repository], ownerUid: p.profile === "critical" && p.id === "demo_chat_bot" ? null : o.ownerUid,
      status: "active", priority: p.profile === "critical" ? "high" : "medium",
      startDate: at(-60), dueDate: at(dueBy[p.profile]), createdAt: ts, updatedAt: ts, isDemoData: true,
    };
    await put("project", await store.projects.get(project.id), () => store.projects.upsert(project), project.id);
    let i = 0;
    for (const [title, status, due, assigned] of DEMO_TASKS[p.profile]) {
      const task: Task = {
        id: `${p.id}_task_${++i}`, organizationId: DEMO_ORG_ID, projectId: p.id, title, description: `${title} for ${p.name}.`,
        status, priority: status === "blocked" ? "high" : "medium", assigneeUid: assigned ? o.ownerUid : null,
        dueDate: at(due), createdAt: ts, updatedAt: ts, isDemoData: true,
      };
      await put("task", await store.tasks.get(task.id), () => store.tasks.upsert(task), task.id);
    }
  }

  for (const d of DEMO_INCIDENTS) {
    const incident: Incident = { ...d, organizationId: DEMO_ORG_ID, createdAt: at(-1), updatedAt: ts, relatedEvidenceIds: [], investigationIds: [], isDemoData: true };
    await put("incident", await store.incidents.get(incident.id), () => store.incidents.upsert(incident), incident.id);
  }
  return report;
}
