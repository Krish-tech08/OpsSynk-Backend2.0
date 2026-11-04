import type { ErrorRequestHandler, RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { isAppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header("x-request-id");
  req.requestId = incoming && /^[A-Za-z0-9_-]{8,64}$/.test(incoming) ? incoming : `req_${randomUUID()}`;
  res.setHeader("X-Request-Id", req.requestId);
  next();
};

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Route not found.", requestId: req.requestId } });
};

/** Consistent error envelope. Never returns stack traces, credentials or raw provider errors. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) return;
  const requestId = req.requestId;
  if (isAppError(err)) {
    if (err.httpStatus >= 500) logger.warn({ requestId, code: err.code }, err.message);
    const body: Record<string, unknown> = { code: err.code, message: err.message, requestId };
    if (err.code === "VALIDATION_FAILED" || err.code === "INVALID_REPOSITORY_MAPPING" || err.code === "RATE_LIMITED") body.details = err.details;
    return res.status(err.httpStatus).json({ success: false, error: body });
  }
  if (err?.type === "entity.parse.failed")
    return res.status(400).json({ success: false, error: { code: "INVALID_JSON", message: "The request body is not valid JSON.", requestId } });
  if (err?.type === "entity.too.large")
    return res.status(413).json({ success: false, error: { code: "PAYLOAD_TOO_LARGE", message: "The request body is too large.", requestId } });
  logger.error({ requestId, err: { name: err?.name, message: err?.message } }, "Unhandled error");
  res.status(500).json({ success: false, error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred.", requestId } });
};
