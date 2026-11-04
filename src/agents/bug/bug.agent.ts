import type { Agent } from "../agent.types.js";
import { cite, narrate, plural } from "../agent.types.js";
import type { Finding } from "../contract.js";
import { bugStats, type BugSeverity } from "../../domain/health/metrics.js";
import type { IssueItem } from "../../integrations/github/github.types.js";
import { isAppError } from "../../utils/errors.js";

const STOP = new Set(["the", "a", "an", "on", "in", "of", "to", "and", "is", "for", "when", "with", "after", "at"]);
const tokens = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)));
export function titleSimilarity(a: string, b: string) {
  const x = tokens(a), y = tokens(b);
  const inter = [...x].filter((w) => y.has(w)).length;
  const union = new Set([...x, ...y]).size;
  return union ? inter / union : 0;
}
const RANK: Record<BugSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, unclassified: 2 };

/** Open bugs by severity, with similar-symptom groupings reported strictly as hypotheses. */
export const bugAgent: Agent = {
  id: "bug",
  async run(ctx) {
    const warnings: string[] = [], unavailableData: string[] = [], findings: Finding[] = [];
    const { repositories } = await ctx.tools.call("bug", "listRepositories", {});
    const all: Array<{ repo: string; issue: IssueItem; severity: BugSeverity }> = [];
    let failed = 0;
    for (const repo of repositories) {
      let s;
      try { s = await ctx.tools.call("bug", "getRepositorySignals", { repositoryId: repo.id }); }
      catch (e) { failed++; unavailableData.push(`${repo.id}: issues unavailable (${isAppError(e) ? e.code : "ERROR"}).`); continue; }
      if (!s.issues.ok) { unavailableData.push(`${repo.id}: issues unavailable (${s.issues.code}).`); continue; }
      const b = bugStats(s.issues.value, ctx.healthConfig);
      const bugs = b.bugs.map((x) => ({ repo: repo.id, issue: x.issue, severity: x.severity }))
        .sort((p, q) => RANK[p.severity] - RANK[q.severity] || p.issue.createdAt.localeCompare(q.issue.createdAt));
      all.push(...bugs);
      if (!bugs.length) continue;
      const crit = bugs.filter((x) => x.severity === "critical");
      if (crit.length)
        findings.push({ id: `bug:critical:${repo.id}`, agentId: "bug", kind: "fact", category: "critical-bugs",
          title: `${plural(crit.length, "critical bug")} open in ${repo.id}`,
          description: `Open bugs labelled critical: ${crit.map((x) => `#${x.issue.number} "${x.issue.title}"`).join(", ")}.`,
          severity: "critical", projectId: null, repositoryId: repo.id, limitations: [],
          evidence: crit.flatMap((x) => cite(ctx, "github", `issue:${repo.id}#${x.issue.number}`)) });
      const rest = bugs.filter((x) => x.severity !== "critical");
      if (rest.length) {
        const top: BugSeverity = rest[0].severity;
        findings.push({ id: `bug:backlog:${repo.id}`, agentId: "bug", kind: "fact", category: "bug-backlog",
          title: `${plural(rest.length, "open bug")} in ${repo.id}${crit.length ? " besides the critical ones" : ""}`,
          description: `Ranked by severity then age: ${rest.slice(0, 5).map((x) => `#${x.issue.number} (${x.severity})`).join(", ")}${rest.length > 5 ? ", …" : ""}.`,
          severity: top === "high" ? "high" : top === "low" ? "low" : "medium", projectId: null, repositoryId: repo.id,
          limitations: b.counts.unclassified ? [`${plural(b.counts.unclassified, "bug")} have no severity label and were weighted as medium.`] : [],
          evidence: rest.flatMap((x) => cite(ctx, "github", `issue:${repo.id}#${x.issue.number}`)) });
      }
    }
    // Similar symptoms → hypothesis only (titles look alike; no shared cause is claimed).
    const used = new Set<string>();
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      const key = [a, b].map((x) => `${x.repo}#${x.issue.number}`).sort().join("|");
      if (used.has(key) || titleSimilarity(a.issue.title, b.issue.title) < 0.5) continue;
      used.add(key);
      findings.push({ id: `bug:similar:${key}`, agentId: "bug", kind: "hypothesis", category: "similar-symptoms",
        title: `Possibly related bugs: ${a.repo}#${a.issue.number} and ${b.repo}#${b.issue.number}`,
        description: `"${a.issue.title}" and "${b.issue.title}" describe similar symptoms. They may share a cause; this is not confirmed.`,
        severity: "medium", projectId: null, repositoryId: a.repo === b.repo ? a.repo : null,
        limitations: ["Based on title similarity only."],
        evidence: [...cite(ctx, "github", `issue:${a.repo}#${a.issue.number}`), ...cite(ctx, "github", `issue:${b.repo}#${b.issue.number}`)] });
    }
    const status = repositories.length && failed === repositories.length ? "failed" : failed || unavailableData.length ? "partial" : "completed";
    const crit = all.filter((x) => x.severity === "critical").length;
    const rules = `${plural(all.length, "open bug")} across ${plural(repositories.length - failed, "repository")}, ${crit} critical. ${plural(findings.filter((f) => f.kind === "hypothesis").length, "possible relationship")} flagged as hypotheses.`;
    const n = await narrate(ctx, "bug", findings, rules, warnings);
    return { agentId: "bug", status, ...n, findings, warnings, unavailableData };
  },
};
