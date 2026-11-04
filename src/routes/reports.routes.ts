import { Router } from "express";
import type { AppContext } from "../context.js";
import { parse } from "../middleware/validation.middleware.js";
import { Id } from "../schemas/common.schemas.js";
import { ok } from "./respond.js";

export function reportRoutes(ctx: AppContext) {
  const r = Router();
  r.get("/:investigationId", async (req, res) => ok(res, await ctx.investigations.report(req.user!.uid, parse(Id, req.params.investigationId))));
  return r;
}
