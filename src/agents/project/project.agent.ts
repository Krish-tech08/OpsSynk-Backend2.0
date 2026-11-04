import type { Agent } from "../agent.types.js";
import { cite, narrate, plural } from "../agent.types.js";
import type { Finding } from "../contract.js";
import { isAppError } from "../../utils/errors.js";

/** Project delivery: stored facts (tasks, owners) kept separate from rule-based inferences (health status, mismatches). */
export const projectAgent: Agent = {
  id: "project",
  async run(ctx) {
    const warnings: string[] = [];
    const unavailableData: string[] = [];
    const findings: Finding[] = [];
    const now = ctx.now();
    const projects = await ctx.tools.call("project", "listProjects", {});
    let failed = 0;
    for (const p of projects) {
      let tasks, health;
      try {
        tasks = await ctx.tools.call("project", "getProjectTasks", { projectId: p.id });
        health = await ctx.tools.call("project", "calculateProjectHealth", { projectId: p.id });
      } catch (e) { failed++; unavailableData.push(`${p.name}: project data unavailable (${isAppError(e) ? e.code : "ERROR"}).`); continue; }
      const projectEv = cite(ctx, "firestore", `project:${p.id}`);
      const healthEv = cite(ctx, "metrics", `project-health:${p.id}`);

      if (health.status === "insufficient_data")
        unavailableData.push(`${p.name}: not enough data for a health score (coverage ${Math.round(health.coverage * 100)}%; missing: ${health.missingSignals.join(", ")}).`);
      else if (health.status !== "healthy")
        findings.push({
          id: `project:health:${p.id}`, agentId: "project", kind: "inference", category: "project-health",
          title: `${p.name} is ${health.status} (${health.score}/100)`,
          description: `${p.name} scored ${health.score}/100 under the configured health rules (data coverage ${Math.round(health.coverage * 100)}%). ` +
            `Sub-scores: ${health.subScores.map((s) => `${s.category} ${s.score ?? "n/a"}`).join(", ")}.`,
          severity: health.status === "critical" ? "critical" : "medium",
          projectId: p.id, repositoryId: null, evidence: [...healthEv, ...projectEv],
          limitations: health.missingSignals.length ? [`Missing signals: ${health.missingSignals.join(", ")}.`] : [],
        });

      const overdue = tasks.filter((t) => t.status !== "done" && t.dueDate && new Date(t.dueDate) < now);
      if (overdue.length)
        findings.push({
          id: `project:overdue:${p.id}`, agentId: "project", kind: "fact", category: "overdue-tasks",
          title: `${plural(overdue.length, "overdue task")} in ${p.name}`,
          description: `Open tasks past their due date: ${overdue.map((t) => `"${t.title}" (${t.status})`).join(", ")}.`,
          severity: overdue.length >= 3 ? "high" : "medium", projectId: p.id, repositoryId: null, limitations: [],
          evidence: overdue.flatMap((t) => cite(ctx, "firestore", `task:${t.id}`)),
        });

      const blocked = tasks.filter((t) => t.status === "blocked");
      if (blocked.length)
        findings.push({
          id: `project:blocked:${p.id}`, agentId: "project", kind: "fact", category: "blocked-tasks",
          title: `${plural(blocked.length, "blocked task")} in ${p.name}`,
          description: `Blocked: ${blocked.map((t) => `"${t.title}"`).join(", ")}.`,
          severity: "high", projectId: p.id, repositoryId: null, limitations: [],
          evidence: blocked.flatMap((t) => cite(ctx, "firestore", `task:${t.id}`)),
        });

      const unassigned = tasks.filter((t) => t.status !== "done" && !t.assigneeUid);
      if (!p.ownerUid || unassigned.length)
        findings.push({
          id: `project:ownership:${p.id}`, agentId: "project", kind: "fact", category: "ownership-gap",
          title: `Ownership gaps in ${p.name}`,
          description: [!p.ownerUid ? "The project has no owner." : null,
            unassigned.length ? `${plural(unassigned.length, "open task")} without an assignee.` : null].filter(Boolean).join(" "),
          severity: !p.ownerUid ? "medium" : "low", projectId: p.id, repositoryId: null, limitations: [],
          evidence: [...(!p.ownerUid ? projectEv : []), ...unassigned.flatMap((t) => cite(ctx, "firestore", `task:${t.id}`))],
        });

      const activity = health.subScores.find((s) => s.category === "activity");
      const inProgress = tasks.filter((t) => t.status === "in_progress");
      if (p.status === "active" && inProgress.length && activity?.score !== null && activity?.score !== undefined && activity.score < 20)
        findings.push({
          id: `project:plan-mismatch:${p.id}`, agentId: "project", kind: "inference", category: "plan-activity-mismatch",
          title: `${p.name}: work in progress but little repository activity`,
          description: `${plural(inProgress.length, "task")} are in progress, but the mapped repositories score ${activity.score}/100 for activity. The work may be happening elsewhere, or the plan may be out of date.`,
          severity: "medium", projectId: p.id, repositoryId: null,
          limitations: ["Inference: repository activity may not capture all project work."],
          evidence: [...healthEv, ...inProgress.flatMap((t) => cite(ctx, "firestore", `task:${t.id}`))],
        });
    }
    const status = projects.length && failed === projects.length ? "failed" : failed ? "partial" : "completed";
    const crit = findings.filter((f) => f.category === "project-health" && f.severity === "critical").length;
    const warn = findings.filter((f) => f.category === "project-health" && f.severity !== "critical").length;
    const rules = `Reviewed ${plural(projects.length - failed, "project")}: ${crit} critical, ${warn} at warning level. ${plural(findings.filter((f) => f.category === "overdue-tasks").length, "project")} with overdue tasks, ${plural(findings.filter((f) => f.category === "blocked-tasks").length, "project")} with blocked tasks.`;
    const n = await narrate(ctx, "project", findings, rules, warnings);
    return { agentId: "project", status, ...n, findings, warnings, unavailableData };
  },
};
