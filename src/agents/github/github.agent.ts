import type { Agent } from "../agent.types.js";
import { cite, narrate, plural } from "../agent.types.js";
import type { Finding } from "../contract.js";
import { activityStats, isStalePullRequest } from "../../domain/health/metrics.js";
import { daysBetween } from "../../utils/time.js";
import { isAppError } from "../../utils/errors.js";

/** Repository activity and pull-request flow. All findings are facts or rule-based inferences with ledger evidence. */
export const githubAgent: Agent = {
  id: "github",
  async run(ctx) {
    const warnings: string[] = [];
    const unavailableData: string[] = [];
    const findings: Finding[] = [];
    const now = ctx.now();
    const { repositories, unmapped } = await ctx.tools.call("github", "listRepositories", {});
    for (const id of unmapped) unavailableData.push(`${id}: repository not found in the GitHub organization or not accessible.`);
    if (!repositories.length) return { agentId: "github", status: unmapped.length ? "partial" : "completed",
      summary: "No repositories are in scope.", summarySource: "rules", findings, warnings, unavailableData };

    let failedRepos = 0;
    for (const repo of repositories) {
      let s;
      try { s = await ctx.tools.call("github", "getRepositorySignals", { repositoryId: repo.id }); }
      catch (e) { failedRepos++; unavailableData.push(`${repo.id}: signals unavailable (${isAppError(e) ? e.code : "ERROR"}).`); continue; }

      for (const [name, sig] of Object.entries({ pullRequests: s.pullRequests, commits: s.commits }))
        if (!sig.ok) unavailableData.push(`${repo.id}: ${name} unavailable (${sig.code}).`);
        else if (sig.truncated) warnings.push(`${repo.id}: ${name} results were truncated by the page limit.`);

      if (s.pullRequests.ok) {
        const stale = s.pullRequests.value.filter((p) => isStalePullRequest(p, now, ctx.healthConfig.windows.stalePrDays));
        if (stale.length) {
          const oldest = Math.max(...stale.map((p) => Math.floor(daysBetween(p.updatedAt, now))));
          findings.push({
            id: `github:stale-prs:${repo.id}`, agentId: "github", kind: "fact", category: "stale-pull-requests",
            title: `${plural(stale.length, "stale pull request")} in ${repo.id}`,
            description: `${plural(stale.length, "open pull request")} in ${repo.id} had no update for at least ${ctx.healthConfig.windows.stalePrDays} days (oldest: ${oldest} days). PRs: ${stale.map((p) => `#${p.number}`).join(", ")}.`,
            severity: oldest >= 21 || stale.length >= 3 ? "high" : "medium",
            projectId: null, repositoryId: repo.id, limitations: [],
            evidence: stale.flatMap((p) => cite(ctx, "github", `pr:${repo.id}#${p.number}`)),
          });
        }
      }
      if (s.commits.ok) {
        const a = activityStats(s.commits.value, repo.pushedAt, now);
        if (a.commitsInWindow === 0) {
          const days = a.daysSinceLastActivity === null ? null : Math.floor(a.daysSinceLastActivity);
          findings.push({
            id: `github:low-activity:${repo.id}`, agentId: "github", kind: "fact", category: "low-activity",
            title: `No recent commits in ${repo.id}`,
            description: `${repo.id} has no commits on ${repo.defaultBranch} in the last ${ctx.healthConfig.windows.activityDays} days` +
              (days === null ? "; no earlier activity was found." : `; the last recorded activity was ${days} days ago (${a.lastActivitySource === "pushed_at" ? "last push to any branch" : "last commit"}).`),
            severity: days === null || days >= 30 ? "high" : "medium",
            projectId: null, repositoryId: repo.id,
            limitations: a.lastActivitySource === "pushed_at" ? ["Recency is based on the repository's last push, which may be to a non-default branch."] : [],
            evidence: cite(ctx, "github", `activity:${repo.id}`),
          });
        }
      }
    }
    const status = failedRepos === repositories.length ? "failed" : failedRepos || unavailableData.length ? "partial" : "completed";
    const stale = findings.filter((f) => f.category === "stale-pull-requests").length;
    const quiet = findings.filter((f) => f.category === "low-activity").length;
    const rules = `Analyzed ${plural(repositories.length - failedRepos, "repository")}. ${plural(stale, "repository")} with stale pull requests; ${plural(quiet, "repository")} without commits in the last ${ctx.healthConfig.windows.activityDays} days.`;
    const n = await narrate(ctx, "github", findings, rules, warnings);
    return { agentId: "github", status, ...n, findings, warnings, unavailableData };
  },
};
