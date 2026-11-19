import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { parse } from "../middleware/validation.middleware.js";
import { Id } from "../schemas/common.schemas.js";
import { requireOrgRole } from "../services/authorization.service.js";
import { ok } from "./respond.js";

const startedAt = new Date();

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
const version = readVersion();

const OrgParams = z.object({ organizationId: Id });

export function metaRoutes(ctx: AppContext) {
  const r = Router();

  r.get("/version", (_req, res) => {
    res.json({
      name: "opssynk-backend",
      version,
      node: process.version,
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  r.get("/api/v1/organizations/:organizationId/me", requireAuth(ctx.verifier), async (req, res) => {
    const { organizationId } = parse(OrgParams, req.params);
    const membership = await requireOrgRole(ctx.store, req.user!.uid, organizationId, "viewer");
    ok(res, {
      uid: membership.uid,
      organizationId: membership.organizationId,
      role: membership.role,
      memberSince: membership.createdAt,
    });
  });

  return r;
}