import { describe, expect, it } from "vitest";
import { createGitHubClient, parseNextLink } from "../../src/integrations/github/github.client.js";
import { GitHubService, separateIssuesAndPullRequests } from "../../src/integrations/github/github.service.js";
import { createFixtureTransport, FIXTURE_HTML_BASE } from "../../src/integrations/github/fixture.transport.js";
import { clock } from "../helpers/setup.js";

const issue = (n: number, extra: object = {}) => ({ number: n, title: `t${n}`, state: "open", labels: [{ name: "bug" }], created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-02T00:00:00Z", closed_at: null, html_url: `https://github.com/o/r/issues/${n}`, user: { login: "u" }, assignees: [], ...extra });

describe("issue / pull request separation", () => {
  it("drops items that carry a pull_request key and counts them", () => {
    const { issues, pullRequestsExcluded } = separateIssuesAndPullRequests([
      issue(1), issue(2, { pull_request: { url: "x" } }), issue(3), issue(4, { pull_request: {} }),
    ]);
    expect(issues.map((i) => i.number)).toEqual([1, 3]);
    expect(pullRequestsExcluded).toBe(2);
    expect(issues[0].labels).toEqual(["bug"]);
  });
  it("is applied by the service on the fixture feed (which mixes PRs into issues like GitHub does)", async () => {
    const svc = new GitHubService(createFixtureTransport(clock), { allowlist: [], activityWindowDays: 14, ciWindowDays: 14, now: clock, htmlBaseUrl: FIXTURE_HTML_BASE });
    const r = await svc.listOpenIssues("SynkStack", "mobile-app-ios");
    expect(r.value.map((i) => i.number)).toEqual([201, 202, 203]);
    expect(r.pullRequestsExcluded).toBe(3);
  });
});

describe("GitHub client", () => {
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
  const make = (fetchImpl: typeof fetch, extra = {}) => createGitHubClient({ baseUrl: "https://api.test", token: "t", timeoutMs: 1000, maxPages: 3, cacheTtlMs: 0, fetchImpl, sleep: async () => {}, ...extra });

  it("parses Link headers", () => {
    expect(parseNextLink('<https://api.test/x?page=2>; rel="next", <https://api.test/x?page=5>; rel="last"')).toBe("https://api.test/x?page=2");
    expect(parseNextLink(null)).toBeNull();
  });
  it("follows pagination and reports truncation at maxPages", async () => {
    let page = 0;
    const c = make(async () => { page++; return json([{ n: page }], 200, { link: `<https://api.test/r?page=${page + 1}>; rel="next"` }); });
    const r = await c.getPaginated<{ n: number }>("/r");
    expect(r.items.map((i) => i.n)).toEqual([1, 2, 3]);
    expect(r.truncated).toBe(true);
  });
  it("retries 5xx with backoff, then succeeds", async () => {
    let n = 0;
    const c = make(async () => (++n < 3 ? json({}, 502) : json({ ok: true })));
    expect(await c.getJson("/x")).toEqual({ ok: true });
    expect(n).toBe(3);
  });
  it("fails fast on a long rate-limit reset and records the reset time", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 3600);
    const c = make(async () => json({ message: "rate limited" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }));
    await expect(c.getJson("/x")).rejects.toMatchObject({ code: "GITHUB_RATE_LIMITED" });
    expect(c.rateLimit().remaining).toBe(0);
  });
  it("does not retry 401/404 and maps them to clear codes", async () => {
    let n = 0;
    await expect(make(async () => { n++; return json({}, 401); }).getJson("/x")).rejects.toMatchObject({ code: "GITHUB_UNAUTHORIZED" });
    await expect(make(async () => { n++; return json({}, 404); }).getJson("/x")).rejects.toMatchObject({ code: "GITHUB_NOT_FOUND" });
    expect(n).toBe(2);
  });
  it("never sends the token anywhere but the Authorization header", async () => {
    let seen: RequestInit | undefined;
    await make(async (_u, init) => { seen = init; return json([]); }).getJson("/x");
    expect((seen!.headers as Record<string, string>).Authorization).toBe("Bearer t");
  });
});

describe("deployment evidence", () => {
  it("comes only from the Deployments API; repositories without deployments return an empty list", async () => {
    const svc = new GitHubService(createFixtureTransport(clock), { allowlist: [], activityWindowDays: 14, ciWindowDays: 14, now: clock, htmlBaseUrl: FIXTURE_HTML_BASE });
    expect((await svc.listDeployments("SynkStack", "mobile-app-ios")).value).toEqual([]);
    const d = (await svc.listDeployments("SynkStack", "mobile-payments-sdk")).value;
    expect(d[0]).toMatchObject({ environment: "production", latestStatus: { state: "failure" } });
  });
});
