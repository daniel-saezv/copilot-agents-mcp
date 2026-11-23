import { describe, expect, it } from "vitest";
import { DEFAULT_MIN_INTERVAL_S } from "./follow-up.ts";
import { initialTask, type TrackedTask } from "./state.ts";
import { aggregateNextCheckAfter, resolveNextCheckAfter } from "./tasks.ts";

describe("resolveNextCheckAfter", () => {
  const createdCheckAfter = "2026-11-23T21:08:40.000Z";

  it("reuses stored check_after until it passes", () => {
    const task: TrackedTask = {
      ...initialTask({
        id: "t",
        repo: "o/r",
        requestedModel: "m",
        state: "in_progress",
        createdAt: "2026-11-23T21:00:00.000Z",
        updatedAt: "2026-11-23T21:00:00.000Z",
      }),
      check_after: createdCheckAfter,
      last_fetched_at: "2026-11-23T21:04:02.000Z",
    };
    const readOne = Date.parse("2026-11-23T21:04:02.000Z");
    const readTwo = Date.parse("2026-11-23T21:05:02.000Z");
    expect(resolveNextCheckAfter(task, readOne)).toBe(createdCheckAfter);
    expect(resolveNextCheckAfter(task, readTwo)).toBe(createdCheckAfter);
  });

  it("after check_after passes uses last_fetched_at plus min interval", () => {
    const lastFetch = "2026-11-23T21:10:00.000Z";
    const task: TrackedTask = {
      ...initialTask({
        id: "t",
        repo: "o/r",
        requestedModel: "m",
        state: "in_progress",
        createdAt: "2026-11-23T21:00:00.000Z",
        updatedAt: "2026-11-23T21:00:00.000Z",
      }),
      check_after: createdCheckAfter,
      last_fetched_at: lastFetch,
    };
    const now = Date.parse("2026-11-23T21:12:00.000Z");
    const expected = new Date(Date.parse(lastFetch) + DEFAULT_MIN_INTERVAL_S * 1000).toISOString();
    expect(resolveNextCheckAfter(task, now)).toBe(expected);
  });
});

describe("aggregateNextCheckAfter", () => {
  it("uses the latest pending next check", () => {
    const early = {
      ...initialTask({
        id: "a",
        repo: "o/r",
        requestedModel: "m",
        state: "in_progress",
        createdAt: "2026-11-23T21:00:00.000Z",
        updatedAt: "2026-11-23T21:00:00.000Z",
      }),
      check_after: "2026-11-23T21:05:00.000Z",
    };
    const late = {
      ...initialTask({
        id: "b",
        repo: "o/r",
        requestedModel: "m",
        state: "in_progress",
        createdAt: "2026-11-23T21:00:00.000Z",
        updatedAt: "2026-11-23T21:00:00.000Z",
      }),
      check_after: "2026-11-23T21:08:00.000Z",
    };
    const now = Date.parse("2026-11-23T21:01:00.000Z");
    expect(aggregateNextCheckAfter([early, late], now)).toBe("2026-11-23T21:08:00.000Z");
  });
});