import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "../repositories/store.js";
import type { Incident } from "../types/domain.js";
import type { InvestigationService } from "./investigation.service.js";
import { authorizeResource, requireOrgRole } from "./authorization.service.js";
import { Id } from "../schemas/common.schemas.js";
import { Errors } from "../utils/errors.js";

export const CreateIncidentSchema = z.object({
  organizationId: Id, projectId: Id.nullable().default(null),
  title: z.string().trim().min(3).max(200), description: z.string().max(4000).default(""),
  severity: z.enum(["sev1", "sev2", "sev3", "sev4"]), status: z.enum(["open", "investigating", "mitigated", "resolved"]).default("open"),
});
export const UpdateIncidentSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(), description: z.string().max(4000).optional(),
  severity: z.enum(["sev1", "sev2", "sev3", "sev4"]).optional(), status: z.enum(["open", "investigating", "mitigated", "resolved"]).optional(),
  projectId: Id.nullable().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, "at least one field is required");

export class IncidentService {
  constructor(private readonly store: Store, private readonly investigations: InvestigationService, private readonly now: () => Date) {}

  private async checkProject(orgId: string, projectId: string | null | undefined) {
    if (!projectId) return;
    const p = await this.store.projects.get(projectId);
    if (!p || p.organizationId !== orgId) throw Errors.validation([{ path: "projectId", message: "Unknown project" }]);
  }

  async list(uid: string, orgId: string) {
    await requireOrgRole(this.store, uid, orgId, "viewer");
    return (await this.store.incidents.list(orgId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async get(uid: string, id: string, minRole: "viewer" | "member" = "viewer") {
    return authorizeResource(this.store, uid, await this.store.incidents.get(id), "Incident", minRole);
  }
  async create(uid: string, input: z.infer<typeof CreateIncidentSchema>): Promise<Incident> {
    await requireOrgRole(this.store, uid, input.organizationId, "member");
    await this.checkProject(input.organizationId, input.projectId);
    const ts = this.now().toISOString();
    const incident: Incident = { id: `inc_${randomUUID()}`, ...input, createdAt: ts, updatedAt: ts, relatedEvidenceIds: [], investigationIds: [] };
    await this.store.incidents.upsert(incident);
    return incident;
  }
  async update(uid: string, id: string, patch: z.infer<typeof UpdateIncidentSchema>) {
    const inc = await this.get(uid, id, "member");
    await this.checkProject(inc.organizationId, patch.projectId);
    const updated: Incident = { ...inc, ...patch, updatedAt: this.now().toISOString() };
    await this.store.incidents.upsert(updated);
    return updated;
  }
  /** Starts an investigation scoped to the incident's project and links it to the incident. */
  async investigate(uid: string, id: string, idempotencyKey?: string) {
    const inc = await this.get(uid, id, "member");
    const { investigation, created } = await this.investigations.create(uid, {
      organizationId: inc.organizationId,
      query: `Investigate incident "${inc.title}" (${inc.severity}): ${inc.description}`.slice(0, 1000),
      scope: { projectIds: inc.projectId ? [inc.projectId] : [], repositoryIds: [] },
    }, { idempotencyKey, incidentId: inc.id });
    if (created) await this.store.incidents.upsert({
      ...inc, status: inc.status === "open" ? "investigating" : inc.status,
      investigationIds: [...inc.investigationIds, investigation.id], updatedAt: this.now().toISOString(),
    });
    return { investigation, created };
  }
}
