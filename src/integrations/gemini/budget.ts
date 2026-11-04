import { Errors } from "../../utils/errors.js";

/**
 * Hard cap on model calls for one investigation. Consumed BEFORE every API attempt (retries included),
 * so the limit can never be exceeded. `reserve` lets low-priority callers leave room for essential calls.
 */
export class ModelCallBudget {
  private used = 0;
  readonly byAgent: Record<string, number> = {};
  constructor(readonly limit: number) {}

  get remaining() { return Math.max(0, this.limit - this.used); }
  get consumed() { return this.used; }

  /** True if a call could be made while still leaving `reserve` calls for others. */
  canSpend(reserve = 0) { return this.remaining > reserve; }

  consume(agentId: string) {
    if (this.used >= this.limit) throw Errors.modelBudgetExceeded(this.limit);
    this.used++;
    this.byAgent[agentId] = (this.byAgent[agentId] ?? 0) + 1;
  }
}

/** Process-wide sliding one-minute window, protecting the account's per-minute quota. */
export class PerMinuteLimiter {
  private stamps: number[] = [];
  constructor(private readonly limit: number, private readonly now: () => number = Date.now) {}
  tryAcquire(): boolean {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < 60_000);
    if (this.stamps.length >= this.limit) return false;
    this.stamps.push(t);
    return true;
  }
}
