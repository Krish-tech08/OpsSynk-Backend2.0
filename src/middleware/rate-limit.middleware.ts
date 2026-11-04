import type { RequestHandler } from "express";
import { Errors } from "../utils/errors.js";

/** Fixed-window, in-process rate limiter (single-instance MVP). Keyed by authenticated uid. */
export function rateLimit(name: string, limit: number, windowMs: number, now: () => number = Date.now): RequestHandler {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const key = `${name}:${req.user?.uid ?? req.ip}`;
    const t = now();
    let w = windows.get(key);
    if (!w || t >= w.resetAt) w = { count: 0, resetAt: t + windowMs };
    w.count += 1;
    windows.set(key, w);
    if (w.count > limit) {
      const retryAfter = Math.ceil((w.resetAt - t) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      return next(Errors.rateLimited(retryAfter));
    }
    next();
  };
}
