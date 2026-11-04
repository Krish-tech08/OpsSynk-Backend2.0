import { z } from "zod";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const csv = z.string().transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean));

/**
 * All configuration, validated at startup. Modes:
 *  - STORAGE_MODE: firestore (default) | memory (local development and tests; data is lost on restart)
 *  - AUTH_MODE:    firebase (default) | dev (accepts "Bearer dev:<uid>"; refused when NODE_ENV=production)
 *  - GITHUB_MODE:  live (default) | fixture (explicit, labelled demo dataset; never presented as live)
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.string().default("info"),

  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  GEMINI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  GEMINI_MAX_CALLS_PER_MINUTE: z.coerce.number().int().positive().default(10),
  MAX_MODEL_CALLS_PER_INVESTIGATION: z.coerce.number().int().min(0).default(8),

  STORAGE_MODE: z.enum(["firestore", "memory"]).default("firestore"),
  FIREBASE_PROJECT_ID: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  AUTH_MODE: z.enum(["firebase", "dev"]).default("firebase"),

  GITHUB_MODE: z.enum(["live", "fixture"]).default("live"),
  GITHUB_ORG: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_REPOSITORY_ALLOWLIST: csv.default([]),
  GITHUB_API_URL: z.string().url().default("https://api.github.com"),
  GITHUB_CACHE_TTL_MS: z.coerce.number().int().min(0).default(60_000),
  GITHUB_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  GITHUB_MAX_PAGES: z.coerce.number().int().positive().default(5),

  /** Browser origins allowed by CORS. Empty = no CORS headers at all (the Android app does not need CORS). */
  CORS_ORIGINS: csv.default([]),
  DEMO_MODE: bool.default(false),
  ENABLED_AGENTS: csv.default(["manager", "github", "project", "bug", "devops", "review"]),

  MAX_INVESTIGATION_DURATION_MS: z.coerce.number().int().positive().default(120_000),
  AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  /** Tool executions per investigation (cache hits are free). Company-wide ≈ 2 + repos + 1 + 2 × projects + 1. */
  MAX_AGENT_TOOL_CALLS: z.coerce.number().int().positive().default(100),
  INVESTIGATION_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  SYNC_RATE_LIMIT: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(600_000),
  HEALTH_CONFIG_PATH: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }
  const env = parsed.data;
  const problems: string[] = [];
  if (env.NODE_ENV === "production" && env.AUTH_MODE === "dev")
    problems.push("AUTH_MODE=dev is not allowed when NODE_ENV=production");
  if (env.STORAGE_MODE === "firestore" && !env.FIREBASE_PROJECT_ID)
    problems.push("FIREBASE_PROJECT_ID is required when STORAGE_MODE=firestore");
  if (env.AUTH_MODE === "firebase" && !env.FIREBASE_PROJECT_ID)
    problems.push("FIREBASE_PROJECT_ID is required when AUTH_MODE=firebase");
  if (env.GITHUB_MODE === "live" && !env.GITHUB_TOKEN)
    problems.push("GITHUB_TOKEN is required when GITHUB_MODE=live (or set GITHUB_MODE=fixture for the labelled demo dataset)");
  const unknownAgents = env.ENABLED_AGENTS.filter((a) => !["manager", "github", "project", "bug", "devops", "review"].includes(a));
  if (unknownAgents.length) problems.push(`Unknown agents in ENABLED_AGENTS: ${unknownAgents.join(", ")}`);
  if (!env.ENABLED_AGENTS.includes("manager")) problems.push("ENABLED_AGENTS must include manager");
  if (problems.length) throw new ConfigError(`Invalid configuration: ${problems.join("; ")}`);
  return env;
}
