import { ConfigError, loadEnv } from "./config/env.js";
import { loadHealthConfig } from "./domain/health/health.config.js";
import { createApp } from "./app.js";
import { buildContext } from "./context.js";
import { createMemoryStore } from "./repositories/memory.store.js";
import { createFirestoreStore } from "./repositories/firestore.store.js";
import { createDevVerifier, createFirebaseVerifier } from "./integrations/firebase/auth.verifier.js";
import { firebaseAuth, firestore, initFirebase } from "./integrations/firebase/admin.js";
import { createGitHubClient } from "./integrations/github/github.client.js";
import { createFixtureTransport } from "./integrations/github/fixture.transport.js";
import { createGeminiClient, createGoogleGenAiTransport } from "./integrations/gemini/gemini.client.js";
import { seedDemo } from "./demo/seed.js";
import { DEMO_GITHUB_ORG } from "./demo/demo-dataset.js";
import { logger } from "./utils/logger.js";

async function main() {
  const env = loadEnv();
  const healthConfig = loadHealthConfig(env.HEALTH_CONFIG_PATH);
  const app = env.STORAGE_MODE === "firestore" || env.AUTH_MODE === "firebase" ? initFirebase(env.FIREBASE_PROJECT_ID!) : null;

  const store = env.STORAGE_MODE === "firestore" ? createFirestoreStore(firestore(app!)) : createMemoryStore();
  const verifier = env.AUTH_MODE === "firebase"
    ? createFirebaseVerifier((t, r) => firebaseAuth(app!).verifyIdToken(t, r))
    : createDevVerifier();
  const transport = env.GITHUB_MODE === "fixture"
    ? createFixtureTransport(() => new Date(), env.GITHUB_ORG ?? DEMO_GITHUB_ORG)
    : createGitHubClient({ baseUrl: env.GITHUB_API_URL, token: env.GITHUB_TOKEN!, timeoutMs: env.GITHUB_TIMEOUT_MS,
        maxPages: env.GITHUB_MAX_PAGES, cacheTtlMs: env.GITHUB_CACHE_TTL_MS });
  const gemini = env.GEMINI_API_KEY
    ? createGeminiClient({ transport: createGoogleGenAiTransport(env.GEMINI_API_KEY), model: env.GEMINI_MODEL, timeoutMs: env.GEMINI_TIMEOUT_MS,
        maxRetries: env.GEMINI_MAX_RETRIES, perMinuteLimit: env.GEMINI_MAX_CALLS_PER_MINUTE })
    : null;
  if (!gemini) logger.warn("GEMINI_API_KEY is not set: agents run in rules-only mode (no AI narration or planning).");
  if (env.GITHUB_MODE === "fixture") logger.warn("GITHUB_MODE=fixture: GitHub data comes from the labelled demo dataset, not live GitHub.");
  if (env.STORAGE_MODE === "memory") logger.warn("STORAGE_MODE=memory: data is not persisted and is lost on restart.");

  const ctx = buildContext({ env, store, verifier, transport, gemini, healthConfig });
  if (env.DEMO_MODE && env.STORAGE_MODE === "memory") {
    const ownerUid = process.env.DEMO_OWNER_UID ?? "demo-owner";
    const r = await seedDemo(store, { ownerUid, viewerUid: process.env.DEMO_VIEWER_UID ?? "demo-viewer", githubOrganization: env.GITHUB_ORG ?? DEMO_GITHUB_ORG, now: new Date() });
    logger.info({ written: r.written, ownerUid }, "In-memory demo data seeded");
  }

  const recovered = await ctx.investigations.recoverInterrupted();
  if (recovered) logger.warn({ recovered }, "Marked investigations interrupted by the previous shutdown as failed");

  const server = createApp(ctx).listen(env.PORT, () => logger.info({ port: env.PORT, storage: store.kind, github: transport.source, auth: verifier.mode, ai: Boolean(gemini) }, "OpsSynk backend listening"));
  const shutdown = (signal: string) => {
    logger.info({ signal }, "Shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => {
  if (e instanceof ConfigError) { console.error(e.message); process.exit(78); }
  logger.fatal({ err: (e as Error)?.message }, "Startup failed");
  process.exit(1);
});
