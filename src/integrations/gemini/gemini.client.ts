import type { ZodType } from "zod";
import { GoogleGenAI } from "@google/genai";
import { AppError, Errors } from "../../utils/errors.js";
import { backoffMs, sleep as realSleep } from "../../utils/time.js";
import { logger } from "../../utils/logger.js";
import { ModelCallBudget, PerMinuteLimiter } from "./budget.js";

export interface GeminiTransport {
  generate(a: { model: string; system: string; prompt: string; jsonSchema?: object; maxOutputTokens: number; abortSignal: AbortSignal }):
    Promise<{ text: string; totalTokens?: number }>;
}

export interface GenerateJsonRequest<T> {
  agentId: string;
  purpose: string;
  system: string;
  prompt: string;
  schema: ZodType<T>;
  jsonSchema?: object;
  budget: ModelCallBudget;
  maxOutputTokens?: number;
}
export interface GenerateJsonResult<T> { data: T; latencyMs: number; totalTokens: number | null; attempts: number }

export interface GeminiClient {
  readonly model: string;
  generateJson<T>(req: GenerateJsonRequest<T>): Promise<GenerateJsonResult<T>>;
  stats(): { requests: number; failures: number; totalTokens: number };
}

/** Official SDK transport. The API key never leaves the backend. */
export function createGoogleGenAiTransport(apiKey: string): GeminiTransport {
  const ai = new GoogleGenAI({ apiKey });
  return {
    async generate(a) {
      const r = await ai.models.generateContent({
        model: a.model,
        contents: a.prompt,
        config: {
          systemInstruction: a.system,
          responseMimeType: "application/json",
          ...(a.jsonSchema ? { responseJsonSchema: a.jsonSchema } : {}),
          maxOutputTokens: a.maxOutputTokens,
          temperature: 0.2,
          abortSignal: a.abortSignal,
        },
      });
      return { text: r.text ?? "", totalTokens: r.usageMetadata?.totalTokenCount };
    },
  };
}

/** Maps provider errors to stable codes. 429/quota is never retried; 5xx and network errors are. */
export function classifyGeminiError(e: unknown): { error: AppError; retryable: boolean } {
  const status = (e as { status?: number })?.status;
  const msg = String((e as Error)?.message ?? "");
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(msg)) return { error: Errors.geminiRateLimited(), retryable: false };
  if (status !== undefined && status >= 400 && status < 500) return { error: Errors.geminiUnavailable("The AI request was rejected."), retryable: false };
  return { error: Errors.geminiUnavailable(), retryable: true };
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  return JSON.parse(trimmed);
}

export function createGeminiClient(o: {
  transport: GeminiTransport; model: string; timeoutMs: number; maxRetries: number; perMinuteLimit: number;
  sleep?: (ms: number) => Promise<void>; now?: () => number;
}): GeminiClient {
  const limiter = new PerMinuteLimiter(o.perMinuteLimit, o.now);
  const sleep = o.sleep ?? realSleep;
  const stats = { requests: 0, failures: 0, totalTokens: 0 };

  return {
    model: o.model,
    stats: () => ({ ...stats }),
    async generateJson<T>(req: GenerateJsonRequest<T>): Promise<GenerateJsonResult<T>> {
      let lastError: AppError = Errors.geminiUnavailable();
      for (let attempt = 0; attempt <= o.maxRetries; attempt++) {
        req.budget.consume(req.agentId);                    // throws MODEL_BUDGET_EXCEEDED before any call
        if (!limiter.tryAcquire()) throw Errors.geminiRateLimited();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), o.timeoutMs);
        const started = Date.now();
        stats.requests++;
        try {
          const r = await o.transport.generate({
            model: o.model, system: req.system, prompt: req.prompt, jsonSchema: req.jsonSchema,
            maxOutputTokens: req.maxOutputTokens ?? 1024, abortSignal: controller.signal,
          });
          clearTimeout(timer);
          const latencyMs = Date.now() - started;
          stats.totalTokens += r.totalTokens ?? 0;
          logger.info({ agentId: req.agentId, purpose: req.purpose, latencyMs, totalTokens: r.totalTokens ?? null, attempt }, "gemini call");
          let parsed: unknown;
          try { parsed = extractJson(r.text); } catch { stats.failures++; throw Errors.invalidModelOutput(); }
          const v = req.schema.safeParse(parsed);
          if (!v.success) { stats.failures++; throw Errors.invalidModelOutput(); }
          return { data: v.data, latencyMs, totalTokens: r.totalTokens ?? null, attempts: attempt + 1 };
        } catch (e) {
          clearTimeout(timer);
          if (e instanceof AppError && (e.code === "INVALID_MODEL_OUTPUT" || e.code === "MODEL_BUDGET_EXCEEDED")) throw e;
          stats.failures++;
          const c = controller.signal.aborted ? { error: Errors.timeout("AI analysis"), retryable: true } : classifyGeminiError(e);
          lastError = c.error;
          logger.warn({ agentId: req.agentId, purpose: req.purpose, code: c.error.code, attempt }, "gemini call failed");
          if (!c.retryable || attempt >= o.maxRetries || !req.budget.canSpend(0)) throw c.error;
          await sleep(backoffMs(attempt, 500, 4000));
        }
      }
      throw lastError;
    },
  };
}

/** Deterministic hallucination guard: every number in model text must appear in the source data. */
export function numbersAreGrounded(text: string, sourceJson: string): boolean {
  const nums = text.match(/\d+(?:\.\d+)?/g) ?? [];
  return nums.every((n) => sourceJson.includes(n));
}
