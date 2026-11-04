import { loadEnv, type Env } from "../../src/config/env.js";
import { DEFAULT_HEALTH_CONFIG } from "../../src/domain/health/health.config.js";
import { buildContext, type AppContext, type ContextDeps } from "../../src/context.js";
import { createApp } from "../../src/app.js";
import { createMemoryStore } from "../../src/repositories/memory.store.js";
import { createFixtureTransport } from "../../src/integrations/github/fixture.transport.js";
import type { GitHubTransport } from "../../src/integrations/github/github.client.js";
import type { AuthVerifier } from "../../src/integrations/firebase/auth.verifier.js";
import { createGeminiClient, type GeminiTransport } from "../../src/integrations/gemini/gemini.client.js";
import { seedDemo } from "../../src/demo/seed.js";
import { DEMO_GITHUB_ORG } from "../../src/demo/demo-dataset.js";
import { Errors } from "../../src/utils/errors.js";

export const NOW = new Date("2026-10-26T12:00:00.000Z");
export const clock = () => new Date(NOW);
export const OWNER = "owner-uid";
export const VIEWER = "viewer-uid";
export const OUTSIDER = "outsider-uid";
export const auth = (uid: string) => ({ Authorization: `Bearer test:${uid}` });

/** Accepts "test:<uid>"; anything else is rejected like an invalid Firebase token. */
export const testVerifier: AuthVerifier = {
  mode: "test",
  async verify(t) {
    const m = /^test:(.+)$/.exec(t);
    if (!m) throw Errors.unauthenticated("The authentication token is invalid or expired.");
    return { uid: m[1] };
  },
};

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({ NODE_ENV: "test", STORAGE_MODE: "memory", AUTH_MODE: "dev", GITHUB_MODE: "fixture", LOG_LEVEL: "silent", ...overrides } as NodeJS.ProcessEnv);
}

/** Gemini transport driven by a handler that sees the purpose (inferred from the prompt). */
export function scriptedGemini(handler: (a: { system: string; prompt: string; purpose: "plan" | "summary" | "synthesis" | "review" }) => unknown,
  calls: string[] = []): GeminiTransport {
  return {
    async generate(a) {
      const purpose = /planning step/.test(a.system) ? "plan" : /final report/.test(a.system) ? "synthesis" : /review step/.test(a.system) ? "review" : "summary";
      calls.push(purpose);
      const out = handler({ system: a.system, prompt: a.prompt, purpose });
      if (out instanceof Error) throw out;
      return { text: typeof out === "string" ? out : JSON.stringify(out), totalTokens: 42 };
    },
  };
}

export async function makeApp(o: {
  env?: Record<string, string>; gemini?: GeminiTransport | null; transport?: GitHubTransport; seed?: boolean; agents?: ContextDeps["agents"];
} = {}): Promise<{ ctx: AppContext; app: ReturnType<typeof createApp> }> {
  const env = testEnv(o.env);
  const store = createMemoryStore();
  const gemini = o.gemini ? createGeminiClient({ transport: o.gemini, model: "test-model", timeoutMs: 2000, maxRetries: 1, perMinuteLimit: 100, sleep: async () => {} }) : null;
  const ctx = buildContext({ env, store, verifier: testVerifier, transport: o.transport ?? createFixtureTransport(clock), gemini,
    healthConfig: DEFAULT_HEALTH_CONFIG, now: clock, agents: o.agents });
  if (o.seed !== false) await seedDemo(store, { ownerUid: OWNER, viewerUid: VIEWER, githubOrganization: DEMO_GITHUB_ORG, now: NOW });
  return { ctx, app: createApp(ctx) };
}
