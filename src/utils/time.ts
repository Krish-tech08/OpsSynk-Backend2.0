export type Clock = () => Date;
export const systemClock: Clock = () => new Date();
export const DAY_MS = 86_400_000;
export const daysBetween = (from: Date | string, to: Date): number =>
  (to.getTime() - new Date(from).getTime()) / DAY_MS;
export const iso = (d: Date) => d.toISOString();
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Bounded exponential backoff with full jitter. */
export const backoffMs = (attempt: number, baseMs = 300, maxMs = 4000) =>
  Math.round(Math.random() * Math.min(maxMs, baseMs * 2 ** attempt));
