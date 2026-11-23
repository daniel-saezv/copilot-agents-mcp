import { describe, expect, it } from "vitest";
import { appendUrlHints, prUrl, sessionUrl } from "./task-urls.ts";
import { buildSummary } from "./task-status.ts";
import { initialTask } from "./state.ts";

describe("task urls", () => {
  it("exposes session_url from stored html_url", () => {
    const task = {
      ...initialTask({
        id: "t",
        repo: "octocat/hello-world",
        requestedModel: "m",
        state: "working",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: null,
        htmlUrl: "https://github.com/octocat/hello-world/copilot/tasks/t",
      }),
    };
    expect(sessionUrl(task)).toBe("https://github.com/octocat/hello-world/copilot/tasks/t");
    expect(prUrl(task)).toBeUndefined();
  });

  it("exposes pr_url when pull html_url exists", () => {
    const task = {
      ...initialTask({
        id: "t",
        repo: "octocat/hello-world",
        requestedModel: "m",
        state: "idle",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        htmlUrl: "https://github.com/octocat/hello-world/copilot/tasks/t",
      }),
      pull_request: { id: 1, number: 7, html_url: "https://github.com/octocat/hello-world/pull/7" },
      completed_at: "2026-01-02T00:00:00Z",
    };
    expect(prUrl(task)).toBe("https://github.com/octocat/hello-world/pull/7");
    const summary = buildSummary(task);
    expect(summary.length).toBeLessThanOrEqual(160);
  });

  it("keeps long summaries without URL text when over 160", () => {
    const base = "a".repeat(150);
    const session = "https://github.com/octocat/hello-world/copilot/tasks/abcdef";
    expect(appendUrlHints(`${base}.`, session)).toBe(`${base}.`);
  });
});