import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ModelCallBudget, PerMinuteLimiter } from "../../src/integrations/gemini/budget.js";
import { createGeminiClient, numbersAreGrounded, type GeminiTransport } from "../../src/integrations/gemini/gemini.client.js";

const Schema = z.object({ summary: z.string() });
const req = (budget: ModelCallBudget) => ({ agentId: "github", purpose: "test", system: "s", prompt: "p", schema: Schema, budget });
const counting = (impl: () => Promise<{ text: string }>) => { const t = { calls: 0, generate: async () => { t.calls++; return impl(); } }; return t; };
const client = (transport: GeminiTransport, extra = {}) => createGeminiClient({ transport, model: "m", timeoutMs: 500, maxRetries: 2, perMinuteLimit: 100, sleep: async () => {}, ...extra });

describe("model-call budget", () => {
  it("counts per agent and refuses calls beyond the limit", () => {
    const b = new ModelCallBudget(2);
    b.consume("a"); b.consume("b");
    expect(() => b.consume("a")).toThrowError(expect.objectContaining({ code: "MODEL_BUDGET_EXCEEDED" }));
    expect(b.byAgent).toEqual({ a: 1, b: 1 });
    expect(b.remaining).toBe(0);
  });
  it("canSpend respects reserved calls", () => {
    const b = new ModelCallBudget(3);
    expect(b.canSpend(2)).toBe(true);
    b.consume("x");
    expect(b.canSpend(2)).toBe(false);
    expect(b.canSpend(1)).toBe(true);
  });
  it("is consumed before the API is called: an exhausted budget makes no request", async () => {
    const t = counting(async () => ({ text: '{"summary":"ok"}' }));
    const b = new ModelCallBudget(0);
    await expect(client(t).generateJson(req(b))).rejects.toMatchObject({ code: "MODEL_BUDGET_EXCEEDED" });
    expect(t.calls).toBe(0);
  });
  it("retries consume budget too, so a limit of 2 caps attempts at 2", async () => {
    const t = counting(async () => { throw Object.assign(new Error("boom"), { status: 503 }); });
    const b = new ModelCallBudget(2);
    await expect(client(t, { maxRetries: 5 }).generateJson(req(b))).rejects.toMatchObject({ code: "GEMINI_UNAVAILABLE" });
    expect(t.calls).toBe(2);
    expect(b.consumed).toBe(2);
  });
  it("does not retry quota errors (429)", async () => {
    const t = counting(async () => { throw Object.assign(new Error("RESOURCE_EXHAUSTED"), { status: 429 }); });
    await expect(client(t).generateJson(req(new ModelCallBudget(5)))).rejects.toMatchObject({ code: "GEMINI_RATE_LIMITED" });
    expect(t.calls).toBe(1);
  });
  it("validates output and rejects malformed JSON or wrong shapes", async () => {
    await expect(client(counting(async () => ({ text: "not json" }))).generateJson(req(new ModelCallBudget(5)))).rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
    await expect(client(counting(async () => ({ text: '{"wrong":1}' }))).generateJson(req(new ModelCallBudget(5)))).rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
    const ok = await client(counting(async () => ({ text: '```json\n{"summary":"fine"}\n```' }))).generateJson(req(new ModelCallBudget(5)));
    expect(ok.data.summary).toBe("fine");
  });
  it("the per-minute limiter blocks bursts without calling the API", async () => {
    let t = 0;
    const lim = new PerMinuteLimiter(2, () => t);
    expect([lim.tryAcquire(), lim.tryAcquire(), lim.tryAcquire()]).toEqual([true, true, false]);
    t = 60_001;
    expect(lim.tryAcquire()).toBe(true);
    const tr = counting(async () => ({ text: '{"summary":"x"}' }));
    const c = client(tr, { perMinuteLimit: 1 });
    await c.generateJson(req(new ModelCallBudget(5)));
    await expect(c.generateJson(req(new ModelCallBudget(5)))).rejects.toMatchObject({ code: "GEMINI_RATE_LIMITED" });
    expect(tr.calls).toBe(1);
  });
  it("number grounding guard", () => {
    expect(numbersAreGrounded("3 stale PRs, score 44", '{"count":3,"score":44}')).toBe(true);
    expect(numbersAreGrounded("7 stale PRs", '{"count":3}')).toBe(false);
  });
});
