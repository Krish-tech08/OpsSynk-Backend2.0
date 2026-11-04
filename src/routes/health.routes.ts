import { Router } from "express";
import type { AppContext } from "../context.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { parse } from "../middleware/validation.middleware.js";
import { OrgQuery } from "../schemas/common.schemas.js";
import { requireOrgRole } from "../services/authorization.service.js";
import { logger } from "../utils/logger.js";
import { ok } from "./respond.js";

/** Liveness/readiness (unauthenticated, no secrets) plus the authenticated engineering-health summary. */
export function healthRoutes(ctx: AppContext) {
  const r = Router();
  r.get("/health", (_req, res) => res.json({ status: "ok" }));
  r.get("/ready", async (_req, res) => {
    const checks: Record<string, "ok" | "unavailable" | "not_configured" | "degraded"> = {};
    try { await ctx.store.organizations.get("readiness-probe"); checks.storage = "ok"; }
    catch (e) { logger.warn({ err: (e as Error)?.message }, "readiness: storage check failed"); checks.storage = "unavailable"; }
    checks.github = ctx.github.source === "fixture" ? "degraded" : "ok";
    checks.gemini = ctx.gemini ? "ok" : "not_configured";
    const ready = checks.storage === "ok";
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_ready", checks,
      modes: { storage: ctx.store.kind, githubData: ctx.github.source, auth: ctx.verifier.mode, demoMode: ctx.env.DEMO_MODE },
    });
  });
  r.get("/api/v1/health/summary", requireAuth(ctx.verifier), async (req, res) => {
    const { organizationId } = parse(OrgQuery, req.query);
    await requireOrgRole(ctx.store, req.user!.uid, organizationId, "viewer");
    const { company } = await ctx.health.companyHealth(organizationId);
    ok(res, {
      organizationId, score: company.score, status: company.status, coverage: company.coverage,
      missingSignals: company.missingSignals, projectCounts: company.projectCounts,
      containsDemoData: company.containsDemoData, dataSource: company.dataSource, computedAt: company.computedAt,
    });
  });
  return r;
}
