import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Env } from "../config/env.js";
import type { Store } from "../repositories/store.js";
import type { GitHubService } from "../integrations/github/github.service.js";
import type { HealthService } from "./health.service.js";
import type { GeminiClient } from "../integrations/gemini/gemini.client.js";
import type { EventBus } from "../domain/investigations/event-bus.js";
import type { Investigation } from "../types/investigation.js";
import { runInvestigation } from "../agents/orchestrator/agent.orchestrator.js";
import { REVIEW_AGENT, SPECIALIST_AGENTS } from "../agents/registry.js";
import type { Agent, ReviewAgent } from "../agents/agent.types.js";
import type { AgentId } from "../types/investigation.js";
import { authorizeResource, requireOrgRole } from "./authorization.service.js";
import { Id } from "../schemas/common.schemas.js";
import { AppError, Errors } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export const CreateInvestigationSchema = z.object({
  organizationId: Id,
  query: z.string().trim().min(3).max(1000),
  scope: z.object({
    projectIds: z.array(Id).max(50).default([]),
    repositoryIds: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,100}$/)).max(50).default([]),
  }).default({ projectIds: [], repositoryIds: [] }),
});
export type CreateInvestigationInput = z.infer<typeof CreateInvestigationSchema>;

const DUPLICATE_WINDOW_MS = 60_000;

export class InvestigationService {
  private readonly running = new Map<string, Promise<void>>();
  /** Concurrent identical submits share one creation (closes the check-then-create race in this process). */
  private readonly creating = new Map<string, Promise<{ investigation: Investigation; created: boolean }>>();
  constructor(private readonly d: {
    env: Env; store: Store; github: GitHubService; health: HealthService; gemini: GeminiClient | null; bus: EventBus; now: () => Date;
    /** Test hook: replace the agent registry (e.g. to inject a failing agent). */
    agents?: { specialists: Partial<Record<AgentId, Agent>>; review: ReviewAgent | null };
  }) {}

  async create(uid: string, input: CreateInvestigationInput, opts: { idempotencyKey?: string; incidentId?: string } = {}): Promise<{ investigation: Investigation; created: boolean }> {
    const key = JSON.stringify([input.organizationId, uid, opts.idempotencyKey ?? null, input.query, input.scope, opts.incidentId ?? null]);
    const inFlight = this.creating.get(key);
    if (inFlight) return { ...(await inFlight), created: false };
    const p = this.createOnce(uid, input, opts).finally(() => this.creating.delete(key));
    this.creating.set(key, p);
    return p;
  }

  private async createOnce(uid: string, input: CreateInvestigationInput, opts: { idempotencyKey?: string; incidentId?: string }): Promise<{ investigation: Investigation; created: boolean }> {
    await requireOrgRole(this.d.store, uid, input.organizationId, "member");
    if (opts.idempotencyKey) {
      const existing = await this.d.store.investigations.findByIdempotencyKey(input.organizationId, uid, opts.idempotencyKey);
      if (existing) return { investigation: existing, created: false };
    }
    // Accidental double submits: same user, same query and scope, still active, within one minute.
    const recent = await this.d.store.investigations.list(input.organizationId, 20);
    const dup = recent.find((i) => i.requestedBy === uid && i.query === input.query && JSON.stringify(i.scope) === JSON.stringify(input.scope)
      && (i.status === "queued" || i.status === "running") && this.d.now().getTime() - Date.parse(i.createdAt) < DUPLICATE_WINDOW_MS
      && (i.incidentId ?? null) === (opts.incidentId ?? null));
    if (dup) return { investigation: dup, created: false };

    for (const pid of input.scope.projectIds) {
      const p = await this.d.store.projects.get(pid);
      if (!p || p.organizationId !== input.organizationId) throw Errors.validation([{ path: "scope.projectIds", message: `Unknown project ${pid}` }]);
    }
    const inv: Investigation = {
      id: `inv_${randomUUID()}`, organizationId: input.organizationId, requestedBy: uid, query: input.query,
      scope: { projectIds: input.scope.projectIds, repositoryIds: input.scope.repositoryIds }, incidentId: opts.incidentId ?? null,
      status: "queued", createdAt: this.d.now().toISOString(), startedAt: null, completedAt: null, agentStatuses: {}, plan: null,
      finalReport: null, warnings: [], errorSummary: null, eventCount: 0, modelCallsUsed: 0, toolCallsUsed: 0,
      idempotencyKey: opts.idempotencyKey ?? null,
    };
    await this.d.store.investigations.create(inv);
    this.start(inv.id);
    return { investigation: inv, created: true };
  }

  /** Runs asynchronously in this process. Completion is observable via events, polling, or waitFor (tests). */
  private start(id: string) {
    const p = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => runInvestigation({ ...this.d, specialists: this.d.agents?.specialists ?? SPECIALIST_AGENTS, review: this.d.agents?.review ?? REVIEW_AGENT }, id))
      .catch((e) => logger.error({ investigationId: id, err: (e as Error)?.message }, "investigation runner crashed"))
      .finally(() => this.running.delete(id));
    this.running.set(id, p);
  }

  async waitFor(id: string) { await this.running.get(id); }

  /**
   * Startup recovery: investigations left queued/running by a previous process cannot be resumed (agents run in-process),
   * so they are marked failed with a persisted terminal event instead of appearing to run forever.
   */
  async recoverInterrupted(): Promise<number> {
    const stale = (await this.d.store.investigations.listActive(500)).filter((i) => !this.running.has(i.id));
    for (const i of stale) {
      await this.d.store.investigations.update(i.id, { status: "failed", completedAt: this.d.now().toISOString(),
        errorSummary: "Interrupted by a server restart before it finished. Start a new investigation." });
      const ev = await this.d.store.events.append({ investigationId: i.id, agentId: null, eventType: "investigation.failed",
        message: "Investigation interrupted by a server restart", status: "failed", timestamp: this.d.now().toISOString(), metadata: { code: "INTERRUPTED" } });
      this.d.bus.publish(ev);
    }
    return stale.length;
  }

  async list(uid: string, organizationId: string, limit: number) {
    await requireOrgRole(this.d.store, uid, organizationId, "viewer");
    return this.d.store.investigations.list(organizationId, limit);
  }

  async get(uid: string, id: string) {
    return authorizeResource(this.d.store, uid, await this.d.store.investigations.get(id), "Investigation", "viewer");
  }

  async events(uid: string, id: string, after: number, limit: number) {
    await this.get(uid, id);
    return this.d.store.events.list(id, after, limit);
  }

  async report(uid: string, id: string) {
    const inv = await this.get(uid, id);
    if (!inv.finalReport) throw new AppError("REPORT_NOT_READY", `The investigation is ${inv.status}; the report is not available yet.`, 409);
    return inv.finalReport;
  }
}
