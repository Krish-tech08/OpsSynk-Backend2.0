
import { describe, expect, it } from "vitest";
import { EvidenceLedger } from "../../src/agents/tools/evidence-ledger.js";
import type { Evidence } from "../../src/agents/contract.js";

const issue: Evidence = {
  sourceType: "github",
  sourceId: "repo#42",
  details: { state: "open", comments: 3 },
};

describe("EvidenceLedger", () => {
  it("starts empty and records evidence", () => {
    const ledger = new EvidenceLedger();

    expect(ledger.size).toBe(0);

    ledger.record(issue);

    expect(ledger.size).toBe(1);
    expect(ledger.has(issue)).toBe(true);
    expect(ledger.get("github", "repo#42")).toEqual(issue);
  });

  it("returns null for evidence that was never recorded", () => {
    const ledger = new EvidenceLedger();

    expect(ledger.get("github", "missing")).toBeNull();
    expect(ledger.has({ sourceType: "metrics", sourceId: "repo#42" }))
      .toBe(false);
  });

  it("stores copies, so later changes to the original do not leak in", () => {
    const ledger = new EvidenceLedger();
    const original: Evidence = structuredClone(issue);

    ledger.record(original);
    original.details.state = "closed";

    expect(ledger.get("github", "repo#42")?.details.state).toBe("open");
  });

  it("matches cited evidence only when every cited detail is identical", () => {
    const ledger = new EvidenceLedger();

    ledger.record(issue);

    expect(ledger.matches(issue)).toEqual({ ok: true });
    expect(ledger.matches({
      ...issue,
      details: { state: "open" },
    }).ok).toBe(true);

    const wrong = ledger.matches({
      ...issue,
      details: { state: "closed" },
    });

    expect(wrong.ok).toBe(false);
    expect(wrong.reason).toMatch(/detail "state" does not match/);
  });

  it("rejects evidence that was never retrieved", () => {
    const result = new EvidenceLedger().matches(issue);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/was not retrieved/);
  });
});
