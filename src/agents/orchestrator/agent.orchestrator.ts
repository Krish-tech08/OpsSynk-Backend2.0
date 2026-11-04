import type { Env } from "../../config/env.js";
import type { Store } from "../../repositories/store.js";
import type { GitHubService } from "../../integrations/github/github.service.js";
import type { HealthService } from "../../services/health.service.js";
import type { GeminiClient } from "../../integrations/gemini/gemini.client.js";
import { ModelCallBudget } from "../../integrations/gemini/budget.js";
import type { EventBus } from "../../domain/investigations/event-bus.js";
import { assertTransition } from "../../domain/investigations/state.js";
import type { AgentId, AgentRunStatus, Investigation } from "../../types/investigation.js";
import type { FinalReport } from "../../domain/reports/report.types.js";
import type { CompanyHealth } from "../../domain/health/health.types.js";
import { EvidenceLedger } from "../tools/evidence-ledger.js";
import { ToolRunner, type Emit } from "../tools/registry.js";
import { validateAgentResult, type AgentResult, type Finding } from "../contract.js";
import type { Agent, AgentRunContext, ReviewAgent } from "../agent.types.js";
import { createPlan, synthesize } from "../manager/manager.agent.js";
import { verifyFindings } from "../review/verification.js";
import { Errors, isAppError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";

export interface OrchestratorDeps {
  env: Env; store: Store; github: GitHubService; health: HealthService; gemini: GeminiClient | null; bus: EventBus; now: () => Date;
  specialists: Partial<Record<AgentId, Agent>>;
  review: ReviewAgent | null;
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) => {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(Errors.timeout(what)), Math.max(1, ms)); })])
    .finally(() => clearTimeout(t));
};

/**
 * Runs one investigation:
 *  1. investigation.started  2. Manager plan  3. GitHub + Project (concurrent)  4. Bug + DevOps (concurrent)
 *  5. deterministic verification + Review agent  6. deterministic company health  7. Manager synthesis
 *  8. persist report + terminal event.
 * Bounded by MAX_INVESTIGATION_DURATION_MS, per-agent timeouts, MAX_MODEL_CALLS_PER_INVESTIGATION and MAX_AGENT_TOOL_CALLS.
 */
export async function runInvestigation(d: OrchestratorDeps, investigationId: string): Promise<void> {
  const inv = await d.store.investigations.get(investigationId);
  if (!inv) throw new Error(`Investigation ${investigationId} not found`);
  const started = Date.now();
  const deadline = started + d.env.MAX_INVESTIGATION_DURATION_MS;
  const enabled = d.env.ENABLED_AGENTS as AgentId[];
  const statuses: Partial<Record<AgentId, AgentRunStatus>> = {};
  const warnings: string[] = [];

  const emit: Emit = async (e) => {
    const ev = await d.store.events.append({ investigationId, agentId: e.agentId, eventType: e.eventType, message: e.message,
      status: e.status, timestamp: d.now().toISOString(), metadata: e.metadata ?? {} });
    d.bus.publish(ev);
  };
  const setStatus = async (a: AgentId, s: AgentRunStatus) => { statuses[a] = s; await d.store.investigations.update(investigationId, { agentStatuses: { ...statuses } }); };

  assertTransition(inv.status, "running");
  await d.store.investigations.update(investigationId, { status: "running", startedAt: d.now().toISOString() });
  await emit({ agentId: null, eventType: "investigation.started", message: "Investigation started", status: "started" });

  try {
    const organization = await d.health.organization(inv.organizationId);
    const ledger = new EvidenceLedger();
    const tools = new ToolRunner({ organization, scope: inv.scope, store: d.store, github: d.github, health: d.health, ledger, now: d.now },
      d.env.MAX_AGENT_TOOL_CALLS, emit);
    const budget = new ModelCallBudget(d.env.MAX_MODEL_CALLS_PER_INVESTIGATION);
    const reserve = (enabled.includes("review") ? 1 : 0) + 1;     // keep calls for review + final synthesis
    const baseCtx = (priorFindings: Finding[]): AgentRunContext => ({
      investigationId, query: inv.query, tools, gemini: d.gemini, budget, reserveCalls: reserve, emit, now: d.now,
      healthConfig: d.health.config, priorFindings,
    });

    // ---- Manager: plan
    await setStatus("manager", "running");
    await emit({ agentId: "manager", eventType: "agent.started", message: "Manager is planning the investigation", status: "started" });
    const { plan, warning } = await createPlan(baseCtx([]), enabled);
    if (warning) warnings.push(warning);
    plan.agents = plan.agents.filter((a) => enabled.includes(a) && d.specialists[a]);
    await d.store.investigations.update(investigationId, { plan });
    await emit({ agentId: "manager", eventType: "manager.plan_created", message: `Plan: ${plan.agents.join(", ") || "no specialist agents"}`,
      status: "completed", metadata: { agents: plan.agents.join(","), source: plan.source } });
    for (const a of plan.agents) await setStatus(a, "pending");
    for (const a of ["github", "project", "bug", "devops"] as AgentId[]) if (!plan.agents.includes(a)) statuses[a] = "skipped";

    // ---- incident context (fact from Firestore, cited like any other evidence)
    const results: AgentResult[] = [];
    if (inv.incidentId) {
      try {
        const i = await tools.call("manager", "getIncidentDetails", { incidentId: inv.incidentId });
        results.push({ agentId: "manager", status: "completed", summary: `Incident "${i.title}" (${i.severity}, ${i.status}).`, summarySource: "rules",
          warnings: [], unavailableData: [], findings: [{
            id: `incident:${i.id}`, agentId: "manager", kind: "fact", category: "incident", title: `Incident: ${i.title}`,
            description: `${i.severity.toUpperCase()} incident, status ${i.status}. ${i.description}`.slice(0, 600),
            severity: i.severity === "sev1" ? "critical" : i.severity === "sev2" ? "high" : i.severity === "sev3" ? "medium" : "low",
            projectId: i.projectId, repositoryId: null, limitations: [], evidence: tools.ledger.get("firestore", `incident:${i.id}`) ? [tools.ledger.get("firestore", `incident:${i.id}`)!] : [] }] });
      } catch (e) { warnings.push(`manager: incident details unavailable (${isAppError(e) ? e.code : "ERROR"}).`); }
    }

    // ---- specialists
    const runAgent = async (id: AgentId, prior: Finding[]) => {
      const agent = d.specialists[id]!;
      await setStatus(id, "running");
      await emit({ agentId: id, eventType: "agent.started", message: `${id} agent started`, status: "started" });
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw Errors.timeout("Investigation");
        const result = validateAgentResult(await withTimeout(agent.run(baseCtx(prior)), Math.min(d.env.AGENT_TIMEOUT_MS, remaining), `${id} agent`));
        results.push(result);
        await setStatus(id, result.status);
        await emit({ agentId: id, eventType: result.status === "failed" ? "agent.failed" : "agent.findings_ready",
          message: `${id} agent ${result.status}: ${result.findings.length} findings`, status: result.status === "failed" ? "failed" : "completed",
          metadata: { findings: result.findings.length, status: result.status, unavailableData: result.unavailableData.length } });
      } catch (e) {
        const code = isAppError(e) ? e.code : (e as Error)?.name === "ZodError" ? "INVALID_AGENT_OUTPUT" : "AGENT_ERROR";
        logger.warn({ investigationId, agentId: id, code }, "agent failed");
        results.push({ agentId: id, status: "failed", summary: `The ${id} agent did not complete (${code}).`, summarySource: "rules",
          findings: [], warnings: [], unavailableData: [`${id} analysis unavailable (${code}).`] });
        await setStatus(id, "failed");
        await emit({ agentId: id, eventType: "agent.failed", message: `${id} agent failed`, status: "failed", metadata: { code } });
      }
    };
    await Promise.all(plan.agents.filter((a) => a === "github" || a === "project").map((a) => runAgent(a, [])));
    const phase1 = results.flatMap((r) => r.findings);
    await Promise.all(plan.agents.filter((a) => a === "bug" || a === "devops").map((a) => runAgent(a, phase1)));

    // ---- verification and review
    let findings = verifyFindings(results.flatMap((r) => r.findings), ledger);
    const unavailableData = results.flatMap((r) => r.unavailableData);
    warnings.push(...results.flatMap((r) => r.warnings));
    let reviewResult: AgentResult | null = null;
    if (enabled.includes("review") && d.review) {
      await setStatus("review", "running");
      await emit({ agentId: "review", eventType: "review.started", message: "Review agent is checking the evidence", status: "started" });
      try {
        reviewResult = validateAgentResult(await withTimeout(d.review.review(baseCtx(findings), findings, results),
          Math.min(d.env.AGENT_TIMEOUT_MS, Math.max(1, deadline - Date.now())), "review agent"));
        findings = reviewResult.findings;
        warnings.push(...reviewResult.warnings);
        unavailableData.push(...reviewResult.unavailableData);
        await setStatus("review", reviewResult.status);
        await emit({ agentId: "review", eventType: "review.completed", message: reviewResult.summary, status: "completed",
          metadata: { verified: findings.filter((f) => f.verification === "verified").length,
            unverified: findings.filter((f) => f.verification === "unverified").length,
            hypotheses: findings.filter((f) => f.verification === "hypothesis").length } });
      } catch (e) {
        await setStatus("review", "failed");
        warnings.push(`review: semantic review unavailable (${isAppError(e) ? e.code : "ERROR"}); deterministic verification was applied.`);
        await emit({ agentId: "review", eventType: "agent.failed", message: "Review agent failed; deterministic verification kept", status: "failed" });
      }
    } else {
      warnings.push("Review agent is not enabled: findings were checked by deterministic evidence verification only.");
    }

    // ---- deterministic health + synthesis
    let health: CompanyHealth | null = null;
    try { health = await tools.call("manager", "calculateCompanyHealth", {}); }
    catch (e) { unavailableData.push(`Company health score unavailable (${isAppError(e) ? e.code : "ERROR"}).`); }
    const synthesis = await synthesize(baseCtx(findings), health, findings, unavailableData, warnings);
    await setStatus("manager", "completed");

    const specialistStatuses = plan.agents.map((a) => statuses[a]);
    const allFailed = plan.agents.length > 0 && specialistStatuses.every((s) => s === "failed");
    const degraded = specialistStatuses.some((s) => s !== "completed") || statuses.review === "failed";
    const finalStatus = allFailed && !health ? "failed" : allFailed || degraded ? "partial" : "completed";
    const report: FinalReport = {
      investigationId, query: inv.query, status: finalStatus === "completed" ? "completed" : "partial", generatedAt: d.now().toISOString(),
      executiveSummary: synthesis.executiveSummary, executiveSummarySource: synthesis.executiveSummarySource, health,
      agentSummaries: [...results.filter((r) => r.agentId !== "manager"), ...(reviewResult ? [reviewResult] : [])].map((r) => ({ agentId: r.agentId, status: r.status, summary: r.summary, summarySource: r.summarySource })),
      findings, recommendations: synthesis.recommendations,
      unavailableData: [...new Set(unavailableData)], warnings: [...new Set(warnings)],
      dataProvenance: { github: d.github.source, projectData: d.store.kind, containsDemoData: d.github.source === "fixture" || Boolean(health?.containsDemoData) },
      budgets: { modelCallsUsed: budget.consumed, modelCallLimit: budget.limit, toolCallsUsed: tools.used, toolCallLimit: d.env.MAX_AGENT_TOOL_CALLS },
    };
    await d.store.investigations.update(investigationId, {
      status: finalStatus, completedAt: d.now().toISOString(), finalReport: report, warnings: report.warnings,
      modelCallsUsed: budget.consumed, toolCallsUsed: tools.used, agentStatuses: { ...statuses },
      errorSummary: finalStatus === "completed" ? null : "One or more agents did not complete; see unavailableData.",
    });
    const terminal = finalStatus === "completed" ? "investigation.completed" : finalStatus === "partial" ? "investigation.partial" : "investigation.failed";
    await emit({ agentId: null, eventType: terminal, message: `Investigation ${finalStatus}`, status: finalStatus === "failed" ? "failed" : "completed",
      metadata: { findings: findings.length, recommendations: report.recommendations.length, modelCalls: budget.consumed, toolCalls: tools.used } });
  } catch (e) {
    const code = isAppError(e) ? e.code : "INTERNAL_ERROR";
    logger.error({ investigationId, code, err: (e as Error)?.message }, "investigation failed");
    await d.store.investigations.update(investigationId, { status: "failed", completedAt: d.now().toISOString(), agentStatuses: { ...statuses },
      errorSummary: `Investigation failed (${code}).`, warnings });
    await emit({ agentId: null, eventType: "investigation.failed", message: `Investigation failed (${code})`, status: "failed", metadata: { code } });
  }
}
