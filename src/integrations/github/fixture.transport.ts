import type { GitHubTransport, Page } from "./github.client.js";
import { DEMO_GITHUB_ORG, DEMO_PROJECTS, type DemoProject } from "../../demo/demo-dataset.js";
import { Errors } from "../../utils/errors.js";
import { DAY_MS } from "../../utils/time.js";

/** Links in fixture data use a reserved .invalid host so they can never be mistaken for real GitHub URLs. */
export const FIXTURE_HTML_BASE = "https://fixtures.opssynk.invalid";

const ago = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();

/** Deterministic GitHub-shaped JSON for one demo repository. */
function repoData(p: DemoProject, org: string, now: Date) {
  const base = `${FIXTURE_HTML_BASE}/${org}/${p.repository}`;
  const user = (login: string) => ({ login });
  const commitDays = { healthy: [0.5, 1, 2, 3, 4, 6, 7, 9, 11, 13], warning: [5, 8, 12], critical: [] as number[] }[p.profile];
  const lastCommitDays = { healthy: 0.5, warning: 5, critical: 35 }[p.profile];

  const pulls = {
    healthy: [{ n: 41, title: "Add offline caching", updated: 1, created: 2 }, { n: 42, title: "Bump dependencies", updated: 0.5, created: 1 }],
    warning: [{ n: 17, title: "Refactor session handling", updated: 12, created: 15 }, { n: 18, title: "Migrate to new API client", updated: 20, created: 26 },
              { n: 19, title: "Fix date formatting", updated: 1, created: 2 }],
    critical: [{ n: 7, title: "Retry logic for payment calls", updated: 30, created: 38 }, { n: 8, title: "Upgrade build toolchain", updated: 45, created: 50 }],
  }[p.profile].map((pr) => ({
    number: pr.n, title: pr.title, draft: false, created_at: ago(now, pr.created), updated_at: ago(now, pr.updated),
    html_url: `${base}/pull/${pr.n}`, user: user("dev-" + pr.n), requested_reviewers: [], base: { ref: "main" },
  }));

  const issues = {
    healthy: [{ n: 101, title: "Typo in settings screen", labels: ["bug", "severity:low"] }, { n: 102, title: "Add dark mode", labels: ["enhancement"] }],
    warning: [{ n: 201, title: "Session expires too early", labels: ["bug", "severity:high"] },
              { n: 202, title: "Wrong time zone in reminders", labels: ["bug", "severity:medium"] },
              { n: 203, title: "Retry banner overlaps content", labels: ["bug", "severity:medium"] }],
    critical: [{ n: 301, title: "Payment request times out on checkout", labels: ["bug", "severity:critical"] },
               { n: 302, title: "Payment request times out on retry", labels: ["bug", "severity:critical"] },
               { n: 303, title: "Crash when card is declined", labels: ["bug", "severity:high"] }],
  }[p.profile].map((i, k) => ({
    number: i.n, title: i.title, state: "open", labels: i.labels.map((name) => ({ name })),
    created_at: ago(now, 10 + k * 3), updated_at: ago(now, 2 + k), closed_at: null,
    html_url: `${base}/issues/${i.n}`, user: user("reporter"), assignees: [],
  }));
  // GitHub's issues endpoint also returns open PRs; the fixture reproduces that so the filter is exercised.
  const issuesFeed = [...issues, ...pulls.map((pr) => ({ ...pr, state: "open", labels: [], closed_at: null, assignees: [], pull_request: { url: pr.html_url } }))];

  const conclusions = {
    healthy: Array(10).fill("success"),
    warning: ["success", "failure", "success", "success", "failure", "success", "failure", "success", "success", "success"],
    critical: ["failure", "failure", "failure", "failure", "failure", "success", "failure", "success"],
  }[p.profile];
  const runs = conclusions.map((c, k) => ({
    id: 9000 + k, name: "CI", display_title: "CI", event: "push", status: "completed", conclusion: c, head_branch: "main",
    created_at: ago(now, 0.3 + k), updated_at: ago(now, 0.25 + k), html_url: `${base}/actions/runs/${9000 + k}`, run_attempt: 1,
  }));

  const commits = commitDays.map((d, k) => ({
    sha: `${p.repository.slice(0, 6)}${String(k).padStart(34, "0")}`,
    commit: { message: `Commit ${k + 1} on ${p.repository}`, author: { name: "dev", date: ago(now, d) }, committer: { date: ago(now, d) } },
    author: user("dev"), html_url: `${base}/commit/${k}`,
  }));

  const deployments = p.hasDeployments
    ? [{ id: 7000, environment: "production", ref: "main", created_at: ago(now, p.profile === "critical" ? 3 : 1) }]
    : [];
  const deploymentStatuses: Record<number, any[]> = {
    7000: [{ state: p.profile === "critical" ? "failure" : "success", created_at: ago(now, p.profile === "critical" ? 3 : 1), environment_url: null, log_url: null }],
  };

  return {
    repo: {
      name: p.repository, full_name: `${org}/${p.repository}`, owner: { login: org }, html_url: base,
      description: `${p.name} (demo fixture)`, default_branch: "main", private: false, archived: false, pushed_at: ago(now, lastCommitDays),
    },
    issuesFeed, pulls, runs, commits, deployments, deploymentStatuses,
    releases: p.profile === "healthy" ? [{ id: 5000, tag_name: "v1.4.0", name: "v1.4.0", published_at: ago(now, 4), html_url: `${base}/releases/tag/v1.4.0`, draft: false, prerelease: false }] : [],
  };
}

/** Serves the labelled demo dataset through the same interface (and normalization code) as the live client. */
export function createFixtureTransport(now: () => Date, org = DEMO_GITHUB_ORG): GitHubTransport {
  const resolve = (path: string): unknown => {
    const parts = path.split("?")[0].split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] === "orgs" && parts[2] === "repos") {
      if (parts[1] !== org) throw Errors.notFound("GitHub organization");
      return DEMO_PROJECTS.map((p) => repoData(p, org, now()).repo);
    }
    if (parts[0] !== "repos" || parts[1] !== org) throw Errors.notFound("GitHub resource");
    const project = DEMO_PROJECTS.find((p) => p.repository === parts[2]);
    if (!project) throw Object.assign(Errors.notFound("GitHub repository"), {});
    const d = repoData(project, org, now());
    const rest = parts.slice(3).join("/");
    if (rest === "") return d.repo;
    if (rest === "issues") return d.issuesFeed;
    if (rest === "pulls") return d.pulls;
    if (rest === "commits") return d.commits;
    if (rest === "actions/runs") return { total_count: d.runs.length, workflow_runs: d.runs };
    if (rest === "releases") return d.releases;
    if (rest === "deployments") return d.deployments;
    const m = /^deployments\/(\d+)\/statuses$/.exec(rest);
    if (m) return d.deploymentStatuses[Number(m[1])] ?? [];
    throw Errors.notFound("GitHub resource");
  };
  return {
    source: "fixture",
    async getJson<T>(path: string) { return structuredClone(resolve(path)) as T; },
    async getPaginated<T>(path: string, _q?: Record<string, string | number>, itemsKey?: string): Promise<Page<T>> {
      const body = resolve(path) as any;
      return { items: structuredClone(itemsKey ? body[itemsKey] : body) as T[], truncated: false };
    },
    rateLimit: () => ({ remaining: null, resetAt: null }),
  };
}
