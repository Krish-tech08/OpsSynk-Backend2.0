import { z } from "zod";

/** Evidence must point at something that was actually retrieved (see EvidenceLedger). */
export const EvidenceSchema = z.object({
  sourceType: z.enum(["github", "firestore", "metrics"]),
  sourceId: z.string().min(1),
  sourceUrl: z.string().url().optional(),
  observedAt: z.string().datetime().optional(),
  details: z.record(z.string(), z.unknown()),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const FindingSchema = z.object({
  id: z.string().min(1),
  agentId: z.string(),
  /** fact = directly observed; inference = derived by rules from facts; hypothesis = plausible, unconfirmed. */
  kind: z.enum(["fact", "inference", "hypothesis"]),
  title: z.string().min(1),
  description: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]),
  category: z.string(),
  projectId: z.string().nullable().default(null),
  repositoryId: z.string().nullable().default(null),
  evidence: z.array(EvidenceSchema),
  confidence: z.number().min(0).max(1).optional(),
  limitations: z.array(z.string()).default([]),
  /** Set by the Review agent. Absent before review. */
  verification: z.enum(["verified", "unverified", "hypothesis"]).optional(),
  reviewNotes: z.array(z.string()).optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const AgentResultSchema = z.object({
  agentId: z.string(),
  status: z.enum(["completed", "partial", "failed"]),
  summary: z.string(),
  summarySource: z.enum(["model", "rules"]),
  findings: z.array(FindingSchema),
  warnings: z.array(z.string()),
  unavailableData: z.array(z.string()).default([]),
});
export type AgentResult = z.infer<typeof AgentResultSchema>;

/** Validate an agent result before it reaches downstream code. Throws on contract violations. */
export function validateAgentResult(value: unknown): AgentResult {
  return AgentResultSchema.parse(value);
}
