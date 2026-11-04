import type { Evidence } from "../contract.js";

/**
 * Records everything the tools actually retrieved during one investigation.
 * Agents build evidence only from ledger entries, and the Review agent verifies each cited
 * evidence item against the ledger, so findings can't cite data that was never retrieved.
 */
export class EvidenceLedger {
  private entries = new Map<string, Evidence>();
  static key(e: Pick<Evidence, "sourceType" | "sourceId">) { return `${e.sourceType}:${e.sourceId}`; }

  record(e: Evidence): Evidence {
    this.entries.set(EvidenceLedger.key(e), structuredClone(e));
    return structuredClone(e);
  }
  get(sourceType: Evidence["sourceType"], sourceId: string): Evidence | null {
    const e = this.entries.get(`${sourceType}:${sourceId}`);
    return e ? structuredClone(e) : null;
  }
  has(e: Pick<Evidence, "sourceType" | "sourceId">) { return this.entries.has(EvidenceLedger.key(e)); }
  /** True when the cited evidence exists and every cited detail equals the recorded value. */
  matches(e: Evidence): { ok: boolean; reason?: string } {
    const stored = this.entries.get(EvidenceLedger.key(e));
    if (!stored) return { ok: false, reason: `Evidence ${EvidenceLedger.key(e)} was not retrieved during this investigation.` };
    for (const [k, v] of Object.entries(e.details))
      if (JSON.stringify(stored.details[k]) !== JSON.stringify(v))
        return { ok: false, reason: `Evidence ${EvidenceLedger.key(e)} detail "${k}" does not match the retrieved value.` };
    return { ok: true };
  }
  get size() { return this.entries.size; }
}
