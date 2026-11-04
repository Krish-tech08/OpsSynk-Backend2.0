import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { parse } from "../middleware/validation.middleware.js";
import { rateLimit } from "../middleware/rate-limit.middleware.js";
import { Id, OrgQuery, PageQuery, paginate } from "../schemas/common.schemas.js";
import { CreateIncidentSchema, UpdateIncidentSchema } from "../services/incident.service.js";
import { ok } from "./respond.js";

export function incidentRoutes(ctx: AppContext) {
  const r = Router();
  const uid = (req: any) => req.user!.uid as string;
  r.get("/", async (req, res) => {
    const { organizationId } = parse(OrgQuery, req.query);
    const { limit, cursor } = parse(PageQuery, req.query);
    const page = paginate(await ctx.incidents.list(uid(req), organizationId), limit, cursor);
    ok(res, page.items, { nextCursor: page.nextCursor, total: page.total });
  });
  r.post("/", async (req, res) => ok(res, await ctx.incidents.create(uid(req), parse(CreateIncidentSchema, req.body)), undefined, 201));
  r.get("/:incidentId", async (req, res) => ok(res, await ctx.incidents.get(uid(req), parse(Id, req.params.incidentId))));
  r.patch("/:incidentId", async (req, res) =>
    ok(res, await ctx.incidents.update(uid(req), parse(Id, req.params.incidentId), parse(UpdateIncidentSchema, req.body))));
  r.post("/:incidentId/investigate", rateLimit("investigations", ctx.env.INVESTIGATION_RATE_LIMIT, ctx.env.RATE_LIMIT_WINDOW_MS), async (req, res) => {
    const key = parse(z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional(), req.header("idempotency-key") ?? undefined);
    const { investigation, created } = await ctx.incidents.investigate(uid(req), parse(Id, req.params.incidentId), key);
    ok(res, { investigationId: investigation.id, status: investigation.status, created }, undefined, created ? 202 : 200);
  });
  return r;
}
