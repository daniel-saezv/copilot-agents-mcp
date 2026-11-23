import { describe, expect, it } from "vitest";
import { buildSummary, durationLabel } from "./task-status.ts";
import { initialTask, type TrackedTask } from "./state.ts";

describe("duration labels", () => {
  it("measures working time from created_at not updated_at", () => {
    const task: TrackedTask = {
      ...initialTask({
        id: "t",
        repo: "o/r",
        requestedModel: "m",
        state: "in_progress",
        createdAt: "2026-11-23T21:00:00.000Z",
        updatedAt: "2026-11-23T21:10:00.000Z",
      }),
    };
    const now = Date.parse("2026-11-23T21:02:00.000Z");
    expect(durationLabel(task, now)).toBe("2m");
    expect(buildSummary(task, { now })).toBe("Working for 2m.");
  });

  it("measures completion after steer from the steer timestamp", () => {
    const task: TrackedTask = {
      ...initialTask({
        id: "t",
        repo: "o/r",
        requestedModel: "m",
        state: "completed",
        createdAt: "2026-11-23T20:00:00.000Z",
        updatedAt: "2026-11-23T21:00:00.000Z",
      }),
      completed_at: "2026-11-23T21:02:45.000Z",
      steer: { at: "2026-11-23T21:02:00.000Z", session_count: 2, turn_seen: true, notified: true },
    };
    expect(durationLabel(task)).toBe("<1m");
    expect(buildSummary(task)).toBe("Completed in <1m; no changes.");
  });

  it("shows sub-minute cancel durations as <1m", () => {
    const task: TrackedTask = {
      ...initialTask({
        id: "t",
        repo: "o/r",
        requestedModel: "m",
        state: "cancelled",
        createdAt: "2026-11-23T21:00:00.000Z",
        updatedAt: "2026-11-23T21:00:11.000Z",
      }),
      completed_at: "2026-11-23T21:00:11.000Z",
    };
    expect(buildSummary(task)).toBe("Cancelled after <1m.");
  });
});