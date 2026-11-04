import { pino } from "pino";

/** Structured logger. Authorization headers and anything named like a secret are redacted. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "*.apiKey", "*.token", "*.GEMINI_API_KEY", "*.GITHUB_TOKEN"],
    censor: "[redacted]",
  },
  base: { service: "opssynk-backend" },
});
export type Logger = typeof logger;
