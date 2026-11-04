import type { Agent } from "../agent.types.js";
import { cite, narrate, plural } from "../agent.types.js";
import type { Finding } from "../contract.js";
import { ciStats } from "../../domain/health/metrics.js";
import { isAppError } from "../../utils/errors.js";

/**
 * CI and deployment signals, kept separate:
 *  - build/CI status comes from GitHub Actions workflow runs;
 *  - deployment status comes ONLY from GitHub Deployments API records. Without them, deployment health is "not assessed".
 */
export const devopsAgent: Agent = {
  id: "devops",
  async run(ctx) {
    const warnings: string[] = [], unavailableData: string[] = [], findings: Finding[] = [];
    const cfg = ctx.healthConfig;
    const { repositories } = await ctx.tools.call("devops", "listRepositories", {});
    let failed = 0, healthyBuilds = 0;
    const noDeploymentData: string[] = [];
    for (const repo of repositories) {
      let s;
      try { s = await ctx.tools.call("devops", "getRepositorySignals", { repositoryId: repo.id }); }
      catch (e) { failed++; unavailableData.push(`${repo.id}: CI and deployment data unavailable (${isAppError(e) ? e.code : "ERROR"}).`); continue; }

      if (!s.workflowRuns.ok) unavailableData.push(`${repo.id}: workflow runs unavailable (${s.workflowRuns.code}).`);
      else {
        const st = ciStats(s.workflowRuns.value, repo.defaultBranch, cfg);
        const failures = s.workflowRuns.value.filter((r) => r.conclusion && cfg.ci.failureConclusions.includes(r.conclusion)).slice(0, 5);
        const ev = failures.flatMap((r) => cite(ctx, "github", `run:${repo.id}#${r.id}`));
        if (st.successRate === null) unavailableData.push(`${repo.id}: no completed workflow runs in the last ${cfg.windows.ciDays} days; build status unknown.`);
        else if (st.consecutiveFailures >= 3) findings.push({
          id: `devops:ci-failing:${repo.id}`, agentId: "devops", kind: "fact", category: "ci-failing",
          title: `CI failing on ${repo.id} (${st.consecutiveFailures} consecutive failures)`,
          description: `The last ${st.consecutiveFailures} completed workflow runs on ${st.branchScope === "default" ? repo.defaultBranch : "all branches"} failed. ` +
            (st.lastSuccessAt ? `The last successful run was at ${st.lastSuccessAt}.` : `No successful run in the last ${cfg.windows.ciDays} days.`),
          severity: st.lastSuccessAt ? "high" : "critical", projectId: null, repositoryId: repo.id, evidence: ev,
          limitations: ["Workflow conclusions combine build and test jobs; individual test results were not analysed."] });
        else if (st.successRate < 0.8) findings.push({
          id: `devops:ci-unstable:${repo.id}`, agentId: "devops", kind: "fact", category: "ci-unstable",
          title: `Intermittent CI failures on ${repo.id}`,
          description: `${st.failures} of ${st.considered} completed runs failed in the last ${cfg.windows.ciDays} days; the latest run passed.`,
          severity: "medium", projectId: null, repositoryId: repo.id, evidence: ev,
          limitations: ["Intermittent failures can come from flaky tests or infrastructure; the cause is not determined."] });
        else healthyBuilds++;
        if (s.workflowRuns.truncated) warnings.push(`${repo.id}: workflow runs were truncated by the page limit.`);
      }

      if (!s.deployments.ok) unavailableData.push(`${repo.id}: deployment records unavailable (${s.deployments.code}).`);
      else if (!s.deployments.value.length) noDeploymentData.push(repo.id);
      else {
        const latest = [...s.deployments.value].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        const state = latest.latestStatus?.state ?? null;
        if (state === "failure" || state === "error")
          findings.push({ id: `devops:deployment-failed:${repo.id}`, agentId: "devops", kind: "fact", category: "deployment-failed",
            title: `Latest ${latest.environment} deployment of ${repo.id} failed`,
            description: `GitHub deployment ${latest.id} to ${latest.environment} (ref ${latest.ref}) reports status "${state}".`,
            severity: latest.environment === "production" ? "high" : "medium", projectId: null, repositoryId: repo.id, limitations: [],
            evidence: cite(ctx, "github", `deployment:${repo.id}#${latest.id}`) });
        else if (!state) unavailableData.push(`${repo.id}: latest deployment has no status; its outcome is unknown.`);
      }
    }
    if (noDeploymentData.length)
      unavailableData.push(`Deployment health not assessed for ${plural(noDeploymentData.length, "repository")} without GitHub deployment records (${noDeploymentData.join(", ")}); only build status is available for them.`);
    const status = repositories.length && failed === repositories.length ? "failed" : failed ? "partial" : "completed";
    const rules = `${plural(healthyBuilds, "repository")} with stable CI, ${plural(findings.filter((f) => f.category.startsWith("ci-")).length, "repository")} with failing or unstable CI, ${plural(findings.filter((f) => f.category === "deployment-failed").length, "failed deployment")}. Deployment data exists for ${plural(repositories.length - failed - noDeploymentData.length, "repository")}.`;
    const n = await narrate(ctx, "devops", findings, rules, warnings);
    return { agentId: "devops", status, ...n, findings, warnings, unavailableData };
  },
};
