import { vi } from "vitest";

/**
 * Runs every test as if the computer's date were months after the pinned test clock (tests/helpers/setup.ts NOW).
 * Any code that reads the machine's date instead of the injected clock then fails on every machine.
 * Time still advances, so timeouts behave normally.
 */
vi.useFakeTimers({ toFake: ["Date"], now: new Date("2027-03-15T08:00:00.000Z"), shouldAdvanceTime: true });
