import { describe, expect, it } from "vitest";
import { githubPageUrl, githubWebHost } from "./github-hosts.ts";

describe("github web host", () => {
  it("defaults to github.com", () => {
    expect(githubWebHost({})).toBe("github.com");
  });

  it("maps api.github.com", () => {
    expect(githubWebHost({ COPILOT_AGENTS_GITHUB_API_BASE_URL: "https://api.github.com" })).toBe("github.com");
  });

  it("maps ghe.com", () => {
    expect(githubWebHost({ COPILOT_AGENTS_GITHUB_API_BASE_URL: "https://api.octocat.ghe.com" })).toBe("octocat.ghe.com");
  });

  it("maps GHE server api v3", () => {
    expect(githubWebHost({ COPILOT_AGENTS_GITHUB_API_BASE_URL: "https://github.example.com/api/v3" })).toBe("github.example.com");
  });
});

describe("github page url", () => {
  const gheEnv = { COPILOT_AGENTS_GITHUB_API_BASE_URL: "https://github.example.com/api/v3" };

  it("accepts github.com pages by default", () => {
    expect(githubPageUrl("https://github.com/octocat/hello-world/pull/1")).toBe("https://github.com/octocat/hello-world/pull/1");
  });

  it("accepts ghe.com pages", () => {
    const env = { COPILOT_AGENTS_GITHUB_API_BASE_URL: "https://api.enterprise.ghe.com" };
    expect(githubPageUrl("https://enterprise.ghe.com/octocat/hello-world/pull/1", env)).toBe("https://enterprise.ghe.com/octocat/hello-world/pull/1");
  });

  it("accepts GHE server pages", () => {
    expect(githubPageUrl("https://github.example.com/octocat/demo/pull/2", gheEnv)).toBe("https://github.example.com/octocat/demo/pull/2");
  });

  it("rejects API hosts and paths", () => {
    expect(githubPageUrl("https://api.github.com/repos/o/r")).toBeUndefined();
    expect(githubPageUrl("https://github.com/api/v3/repos/o/r")).toBeUndefined();
    expect(githubPageUrl("https://github.example.com/api/v3/repos/o/r", gheEnv)).toBeUndefined();
    expect(githubPageUrl("https://github.com/repos/o/r/pulls/1")).toBeUndefined();
  });
});