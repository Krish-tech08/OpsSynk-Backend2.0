import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Router } from "express";
import type { AppContext } from "../context.js";

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

  return r;
}