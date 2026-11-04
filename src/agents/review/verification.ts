import type { Finding } from "../contract.js";
import type { EvidenceLedger } from "../tools/evidence-ledger.js";

/**
 * Deterministic verification (runs before any model review):
 *  - a finding with no evidence is unverified
 *  - every cited evidence item must exist in the ledger with matching details
 *  - hypotheses stay hypotheses and are capped at medium severity
 *  - an inference rated critical needs at least two evidence items, otherwise it is downgraded to high
 */
export function verifyFindings(findings: Finding[], ledger: EvidenceLedger): Finding[] {
  return findings.map((f) => {
    const notes: string[] = [];
    let severity = f.severity;
    let verification: Finding["verification"];
    if (!f.evidence.length) { verification = "unverified"; notes.push("No supporting evidence was provided."); }
    else {
      const problems = f.evidence.map((e) => ledger.matches(e)).filter((m) => !m.ok).map((m) => m.reason!);
      if (problems.length) { verification = "unverified"; notes.push(...problems); }
      else verification = f.kind === "hypothesis" ? "hypothesis" : "verified";
    }
    if (f.kind === "hypothesis" && (severity === "critical" || severity === "high")) {
      severity = "medium"; notes.push("Severity capped at medium because this is a hypothesis.");
    }
    if (f.kind === "inference" && severity === "critical" && f.evidence.length < 2) {
      severity = "high"; notes.push("Downgraded from critical: an inference needs at least two evidence items to be critical.");
    }
    return { ...f, severity, verification, reviewNotes: [...(f.reviewNotes ?? []), ...notes] };
  });
}
