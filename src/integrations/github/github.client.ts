import { AppError, Errors } from "../../utils/errors.js";
import { backoffMs, sleep as realSleep } from "../../utils/time.js";
import type { DataSource } from "./github.types.js";

export interface Page<T> { items: T[]; truncated: boolean }

/** Minimal GitHub REST transport. The fixture transport implements the same interface with stored data. */
export interface GitHubTransport {
  source: DataSource;
  getJson<T>(path: string, query?: Record<string, string | number>): Promise<T>;
  /** Follows Link: rel="next" up to maxPages. `itemsKey` handles endpoints that wrap arrays (e.g. workflow_runs). */
  getPaginated<T>(path: string, query?: Record<string, string | number>, itemsKey?: string): Promise<Page<T>>;
  rateLimit(): { remaining: number | null; resetAt: string | null };
}

export interface GitHubClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  maxPages: number;
  cacheTtlMs: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Longest rate-limit wait we accept inside one request before failing fast. */
  maxRateLimitWaitMs?: number;
}

export function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim());
    if (m && m[2] === "next") return m[1];
  }
  return null;
}

export function createGitHubClient(o: GitHubClientOptions): GitHubTransport {
  const fetchImpl = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? realSleep;
  const now = o.now ?? Date.now;
  const maxRetries = o.maxRetries ?? 3;
  const maxWait = o.maxRateLimitWaitMs ?? 5_000;
  const cache = new Map<string, { expires: number; body: unknown; link: string | null }>();
  let rate: { remaining: number | null; resetAt: string | null } = { remaining: null, resetAt: null };

  const url = (path: string, query?: Record<string, string | number>) => {
    const u = new URL(path.startsWith("http") ? path : `${o.baseUrl.replace(/\/$/, "")}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, String(v));
    return u.toString();
  };

  async function request(target: string): Promise<{ body: unknown; link: string | null }> {
    const hit = cache.get(target);
    if (hit && hit.expires > now()) return { body: hit.body, link: hit.link };
    let lastError: AppError = Errors.githubUnavailable();
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), o.timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(target, {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            Authorization: `Bearer ${o.token}`,
            "User-Agent": "opssynk-backend",
          },
          signal: controller.signal,
        });
      } catch {
        clearTimeout(timer);
        lastError = Errors.githubUnavailable("GitHub did not respond in time.");
        if (attempt < maxRetries) { await sleep(backoffMs(attempt)); continue; }
        throw lastError;
      }
      clearTimeout(timer);
      const remaining = res.headers.get("x-ratelimit-remaining");
      const reset = res.headers.get("x-ratelimit-reset");
      if (remaining !== null) rate = { remaining: Number(remaining), resetAt: reset ? new Date(Number(reset) * 1000).toISOString() : null };

      if (res.ok) {
        const body = await res.json();
        const link = res.headers.get("link");
        if (o.cacheTtlMs > 0) cache.set(target, { expires: now() + o.cacheTtlMs, body, link });
        return { body, link };
      }
      if (res.status === 401) throw new AppError("GITHUB_UNAUTHORIZED", "GitHub rejected the configured credentials.", 502);
      if (res.status === 404) throw new AppError("GITHUB_NOT_FOUND", "The GitHub resource was not found or is not accessible.", 404);
      const retryAfter = res.headers.get("retry-after");
      const isRateLimited = res.status === 429 || (res.status === 403 && (remaining === "0" || retryAfter !== null));
      if (isRateLimited) {
        const waitMs = retryAfter !== null ? Number(retryAfter) * 1000 : reset ? Number(reset) * 1000 - now() : maxWait + 1;
        if (attempt < maxRetries && waitMs <= maxWait) { await sleep(Math.max(0, waitMs)); continue; }
        throw Errors.githubRateLimited(rate.resetAt ?? undefined);
      }
      if (res.status === 403) throw new AppError("GITHUB_FORBIDDEN", "The GitHub credentials lack permission for this resource.", 502);
      if (res.status >= 500) {
        lastError = Errors.githubUnavailable();
        if (attempt < maxRetries) { await sleep(backoffMs(attempt)); continue; }
        throw lastError;
      }
      throw new AppError("GITHUB_REQUEST_FAILED", `GitHub request failed with status ${res.status}.`, 502);
    }
    throw lastError;
  }

  return {
    source: "github",
    async getJson<T>(path: string, query?: Record<string, string | number>) {
      return (await request(url(path, query))).body as T;
    },
    async getPaginated<T>(path: string, query: Record<string, string | number> = {}, itemsKey?: string) {
      const items: T[] = [];
      let next: string | null = url(path, { per_page: 100, ...query });
      let pages = 0;
      while (next && pages < o.maxPages) {
        const { body, link }: { body: unknown; link: string | null } = await request(next);
        const pageItems = (itemsKey ? (body as Record<string, unknown>)[itemsKey] : body) as T[];
        items.push(...(pageItems ?? []));
        next = parseNextLink(link);
        pages++;
      }
      return { items, truncated: next !== null };
    },
    rateLimit: () => ({ ...rate }),
  };
}
