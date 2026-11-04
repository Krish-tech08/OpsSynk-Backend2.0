import type { InvestigationStatus } from "../../types/investigation.js";

/** Allowed investigation status transitions. Terminal states never change. */
const TRANSITIONS: Record<InvestigationStatus, InvestigationStatus[]> = {
  queued: ["running", "failed"],
  running: ["completed", "partial", "failed"],
  completed: [],
  partial: [],
  failed: [],
};

export const isTerminal = (s: InvestigationStatus) => TRANSITIONS[s].length === 0;
export const canTransition = (from: InvestigationStatus, to: InvestigationStatus) => TRANSITIONS[from].includes(to);

export function assertTransition(from: InvestigationStatus, to: InvestigationStatus): void {
  if (!canTransition(from, to)) throw new Error(`Invalid investigation status transition: ${from} → ${to}`);
}
