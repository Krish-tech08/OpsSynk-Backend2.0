import type { RequestHandler } from "express";

/**
 * Browser-only CORS. Native clients (the Android app) send no Origin header and are unaffected.
 * Only origins listed in CORS_ORIGINS receive CORS headers; with an empty list, no CORS headers are sent at all.
 */
export function corsForBrowsers(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.header("origin");
    if (!origin) return next();
    res.setHeader("Vary", "Origin");
    const ok = allowed.has(origin);
    if (ok) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Expose-Headers", "Retry-After, X-Request-Id");
    }
    if (req.method === "OPTIONS") {
      if (!ok) return res.status(403).end();
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, Last-Event-ID");
      res.setHeader("Access-Control-Max-Age", "600");
      return res.status(204).end();
    }
    next();
  };
}
