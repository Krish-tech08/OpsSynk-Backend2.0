import { Router } from "express";
import type { AppContext } from "../context.js";
import { parse } from "../middleware/validation.middleware.js";
import { OrgQuery } from "../schemas/common.schemas.js";
import { requireOrgRole } from "../services/authorization.service.js";
import { ok } from "./respond.js";

export function analyticsRoutes(ctx: AppContext) {
  const r = Router();
  r.get("/company", async (req, res) => {
    const { organizationId } = parse(OrgQuery, req.query);
    await requireOrgRole(ctx.store, req.user!.uid, organizationId, "viewer");
    const { company } = await ctx.health.companyHealth(organizationId);
    ok(res, { ...company, weights: ctx.health.config.weights, bands: ctx.health.config.bands });
  });
  r.get("/projects", async (req, res) => {
    const { organizationId } = parse(OrgQuery, req.query);
    await requireOrgRole(ctx.store, req.user!.uid, organizationId, "viewer");
    const { projects, company } = await ctx.health.companyHealth(organizationId);
    ok(res, projects.sort((a, b) => (a.score ?? 101) - (b.score ?? 101)), { excludedProjects: company.excludedProjects });
  });
  return r;
}
