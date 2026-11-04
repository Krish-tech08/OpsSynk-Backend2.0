import type { RequestHandler } from "express";
import type { AuthVerifier } from "../integrations/firebase/auth.verifier.js";
import { Errors } from "../utils/errors.js";

/** Requires "Authorization: Bearer <token>" and attaches req.user. Runs before any private data access. */
export const requireAuth = (verifier: AuthVerifier): RequestHandler => async (req, _res, next) => {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return next(Errors.unauthenticated());
  try {
    req.user = await verifier.verify(match[1].trim());
    next();
  } catch (e) {
    next(e);
  }
};
