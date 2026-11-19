
import { describe, expect, it } from "vitest";
import { backoffMs, DAY_MS, daysBetween, iso } from "../../src/utils/time.js";

describe("time utilities", () => {
  it("DAY_MS is one day in milliseconds", () => {
    expect(DAY_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("daysBetween counts whole and partial days", () => {
    const to = new Date("2026-10-26T12:00:00.000Z");

    expect(daysBetween("2026-10-19T12:00:00.000Z", to)).toBe(7);
    expect(daysBetween(new Date("2026-10-26T00:00:00.000Z"), to)).toBe(0.5);
  });

  it("daysBetween is negative when the start date is in the future", () => {
    const to = new Date("2026-10-26T12:00:00.000Z");

    expect(daysBetween("2026-10-28T12:00:00.000Z", to)).toBe(-2);
  });

  it("iso returns an ISO 8601 UTC string", () => {
    expect(iso(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))))
      .toBe("2026-01-02T03:04:05.000Z");
  });

  it("backoffMs stays between 0 and the cap for every attempt", () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      for (let i = 0; i < 50; i++) {
        const ms = backoffMs(attempt, 300, 4000);

        expect(ms).toBeGreaterThanOrEqual(0);
        expect(ms).toBeLessThanOrEqual(Math.min(4000, 300 * 2 ** attempt));
        expect(Number.isInteger(ms)).toBe(true);
      }
    }
  });
});
