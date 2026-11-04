import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { parse } from "../middleware/validation.middleware.js";
import { rateLimit } from "../middleware/rate-limit.middleware.js";
import { Id, OrgQuery } from "../schemas/common.schemas.js";
import { CreateInvestigationSchema } from "../services/investigation.service.js";
import { TERMINAL_EVENTS, type InvestigationEvent } from "../types/investigation.js";
import { isTerminal } from "../domain/investigations/state.js";
import { ok } from "./respond.js";

const IdemKey = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional();
const After = z.coerce.number().int().min(0).default(0);

export function agentRoutes(ctx: AppContext) {
  const r = Router();
  const uid = (req: Request) => req.user!.uid;

  r.post("/investigations", rateLimit("investigations", ctx.env.INVESTIGATION_RATE_LIMIT, ctx.env.RATE_LIMIT_WINDOW_MS), async (req, res) => {
    const input = parse(CreateInvestigationSchema, req.body);
    const idempotencyKey = parse(IdemKey, req.header("idempotency-key") ?? undefined);
    const { investigation, created } = await ctx.investigations.create(uid(req), input, { idempotencyKey });
    ok(res, { investigationId: investigation.id, status: investigation.status, created,
      links: { self: `/api/v1/agents/investigations/${investigation.id}`, events: `/api/v1/agents/investigations/${investigation.id}/events`,
        stream: `/api/v1/agents/investigations/${investigation.id}/stream` } }, undefined, created ? 202 : 200);
  });
  r.get("/investigations", async (req, res) => {
    const { organizationId } = parse(OrgQuery, req.query);
    const limit = parse(z.coerce.number().int().min(1).max(100).default(20), req.query.limit);
    const list = await ctx.investigations.list(uid(req), organizationId, limit);
    ok(res, list.map(({ finalReport, ...rest }) => ({ ...rest, hasReport: finalReport !== null })));
  });
  r.get("/investigations/:investigationId", async (req, res) => ok(res, await ctx.investigations.get(uid(req), parse(Id, req.params.investigationId))));

  /** Polling: events with sequence > after. */
  r.get("/investigations/:investigationId/events", async (req, res) => {
    const id = parse(Id, req.params.investigationId);
    const after = parse(After, req.query.after);
    const events = await ctx.investigations.events(uid(req), id, after, 200);
    const inv = await ctx.investigations.get(uid(req), id);
    ok(res, events, { investigationStatus: inv.status, lastSequence: events.at(-1)?.sequence ?? after, done: isTerminal(inv.status) });
  });

  /**
   * Server-Sent Events. Replays persisted events after Last-Event-ID (or ?after=), then streams live ones.
   * Reconnecting never starts or duplicates an investigation; the stream closes after the terminal event.
   */
  r.get("/investigations/:investigationId/stream", async (req: Request, res: Response) => {
    const id = parse(Id, req.params.investigationId);
    const inv = await ctx.investigations.get(uid(req), id);
    let last = parse(After, req.header("last-event-id") ?? req.query.after);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(": connected\n\n");
    const queue: InvestigationEvent[] = [];
    let replaying = true;
    let closed = false;
    const send = (e: InvestigationEvent) => {
      if (closed || e.sequence <= last) return;
      last = e.sequence;
      res.write(`id: ${e.sequence}\nevent: ${e.eventType}\ndata: ${JSON.stringify(e)}\n\n`);
      if (TERMINAL_EVENTS.includes(e.eventType)) finish();
    };
    const unsubscribe = ctx.bus.subscribe(id, (e) => (replaying ? queue.push(e) : send(e)));
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
    const finish = () => { if (closed) return; closed = true; clearInterval(heartbeat); unsubscribe(); res.end(); };
    req.on("close", finish);
    // Replay persisted history, then drain anything that arrived meanwhile (deduplicated by sequence).
    for (;;) {
      const page = await ctx.store.events.list(id, last, 200);
      page.forEach(send);
      if (page.length < 200 || closed) break;
    }
    replaying = false;
    queue.sort((a, b) => a.sequence - b.sequence).forEach(send);
    if (!closed && isTerminal(inv.status)) {
      const fresh = await ctx.store.events.list(id, last, 200);
      fresh.forEach(send);
      finish();
    }
  });
  return r;
}
