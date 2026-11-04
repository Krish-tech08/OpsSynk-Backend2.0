import type { FinalReport } from "../domain/reports/report.types.js";

export const AGENT_IDS = ["manager", "github", "project", "bug", "devops", "review"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export type InvestigationStatus = "queued" | "running" | "completed" | "partial" | "failed";
export type AgentRunStatus = "pending" | "running" | "completed" | "partial" | "failed" | "skipped";

export interface InvestigationPlan {
  agents: AgentId[];
  rationale: string;
  /** "model" when Gemini proposed the plan (validated), "rules" when the deterministic default was used. */
  source: "model" | "rules";
}

export interface Investigation {
  id: string;
  organizationId: string;
  requestedBy: string;
  query: string;
  scope: { projectIds: string[]; repositoryIds: string[] };
  incidentId: string | null;
  status: InvestigationStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  agentStatuses: Partial<Record<AgentId, AgentRunStatus>>;
  plan: InvestigationPlan | null;
  finalReport: FinalReport | null;
  warnings: string[];
  errorSummary: string | null;
  eventCount: number;
  modelCallsUsed: number;
  toolCallsUsed: number;
  idempotencyKey: string | null;
}

export const EVENT_TYPES = [
  "investigation.started", "manager.plan_created", "agent.started", "tool.started", "tool.completed", "tool.failed",
  "agent.findings_ready", "agent.failed", "review.started", "review.completed",
  "investigation.completed", "investigation.partial", "investigation.failed",
] as const;
export type InvestigationEventType = (typeof EVENT_TYPES)[number];
export const TERMINAL_EVENTS: InvestigationEventType[] = ["investigation.completed", "investigation.partial", "investigation.failed"];

export interface InvestigationEvent {
  id: string;
  investigationId: string;
  sequence: number;
  agentId: AgentId | null;
  eventType: InvestigationEventType;
  message: string;
  status: "started" | "completed" | "failed" | "info";
  timestamp: string;
  metadata: Record<string, string | number | boolean | null>;
}
