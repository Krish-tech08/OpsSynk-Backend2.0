import type { Finding } from "../../agents/contract.js";
import type { CompanyHealth } from "../health/health.types.js";

export interface Recommendation {
  id: string;
  title: string;
  rationale: string;
  priority: "now" | "soon" | "later";
  /** Every recommendation must cite at least one verified finding. */
  findingIds: string[];
  source: "model" | "rules";
}

export interface FinalReport {
  investigationId: string;
  query: string;
  status: "completed" | "partial";
  generatedAt: string;
  executiveSummary: string;
  executiveSummarySource: "model" | "rules";
  health: CompanyHealth | null;
  agentSummaries: Array<{ agentId: string; status: string; summary: string; summarySource: "model" | "rules" }>;
  findings: Finding[];
  recommendations: Recommendation[];
  unavailableData: string[];
  warnings: string[];
  dataProvenance: { github: "github" | "fixture"; projectData: "firestore" | "memory"; containsDemoData: boolean };
  budgets: { modelCallsUsed: number; modelCallLimit: number; toolCallsUsed: number; toolCallLimit: number };
}
