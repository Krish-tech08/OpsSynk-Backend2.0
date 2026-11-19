
import { describe, expect, it } from "vitest";
import { verifyFindings } from "../../src/agents/review/verification.js";
import { EvidenceLedger } from "../../src/agents/tools/evidence-ledger.js";
import type { Evidence, Finding } from "../../src/agents/contract.js";

const e1: Evidence = {
  sourceType: "github",
  sourceId: "repo#1",
  details: { state: "open" },
};

const e2: Evidence = {
  sourceType: "metrics",
  sourceId: "ci-rate",
  details: { value: 0.4 },
};

function finding(over: Partial<Finding>): Finding {
  return {
    id: "f1",
    agentId: "github",
    kind: "fact",
    title: "Title",
    description: "Description",
    severity: "medium",
    category: "quality",
    projectId: null,
    repositoryId: null,
    evidence: [e1],
    limitations: [],
    ...over,
  };
}

function ledgerWith(...items: Evidence[]) {
  const ledger = new EvidenceLedger();
  items.forEach((e) => ledger.record(e));
  return ledger;
}

describe("verifyFindings", () => {
  it("marks a fact with matching evidence as verified", () => {
    const [f] = verifyFindings([finding({})], ledgerWith(e1));

    expect(f.verification).toBe("verified");
    expect(f.reviewNotes).toEqual([]);
  });

  it("marks a finding without evidence as unverified", () => {
    const [f] = verifyFindings(
      [finding({ evidence: [] })],
      ledgerWith(e1)
    );

    expect(f.verification).toBe("unverified");
    expect(f.reviewNotes?.[0]).toMatch(/No supporting evidence/);
  });

  it("marks a finding citing unknown evidence as unverified", () => {
    const [f] = verifyFindings([finding({})], ledgerWith());

    expect(f.verification).toBe("unverified");
  });

  it("caps hypotheses at medium severity", () => {
    const [f] = verifyFindings(
      [finding({ kind: "hypothesis", severity: "critical" })],
      ledgerWith(e1)
    );

    expect(f.verification).toBe("hypothesis");
    expect(f.severity).toBe("medium");
  });

  it("downgrades a critical inference with only one evidence item to high", () => {
    const [f] = verifyFindings(
      [finding({ kind: "inference", severity: "critical" })],
      ledgerWith(e1)
    );

    expect(f.severity).toBe("high");
  });

  it("keeps a critical inference that has two evidence items", () => {
    const [f] = verifyFindings(
      [finding({
        kind: "inference",
        severity: "critical",
        evidence: [e1, e2],
      })],
      ledgerWith(e1, e2)
    );

    expect(f.severity).toBe("critical");
    expect(f.verification).toBe("verified");
  });

  it("does not change the input findings", () => {
    const input = finding({ kind: "hypothesis", severity: "high" });

    verifyFindings([input], ledgerWith(e1));

    expect(input.severity).toBe("high");
    expect(input.verification).toBeUndefined();
  });
});
