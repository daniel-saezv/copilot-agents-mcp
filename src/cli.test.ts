import { describe, expect, it } from "vitest";
import { ignoredTokenWarning, readActiveToken } from "./auth.ts";
import { githubApiBase, parseArgs, supportsNode } from "./cli.ts";

describe("cli", () => {
  it("serves over stdio by default", () => {
    expect(parseArgs([])).toEqual({ command: "serve" });
    expect(parseArgs(["watch"])).toEqual({ command: "watch" });
    expect(parseArgs(["login"])).toEqual({ command: "login" });
    expect(parseArgs(["logout"])).toEqual({ command: "logout" });
    expect(parseArgs(["auth", "status"])).toEqual({ command: "status" });
    expect(parseArgs(["--version"])).toEqual({ command: "version" });
    expect(() => parseArgs(["auth"])).toThrow(/auth status/);
    expect(() => parseArgs(["login", "--http"])).toThrow(/does not accept/);
    expect(() => parseArgs(["--http"])).toThrow(/Unknown argument/);
    expect(() => parseArgs(["--toolsets", "copilot_models"])).toThrow(/Unknown argument/);
    expect(() => parseArgs(["--read-only"])).toThrow(/Unknown argument/);
  });

  it("requires https for GitHub base URL unless loopback", () => {
    expect(() => githubApiBase({ COPILOT_AGENTS_GITHUB_API_BASE_URL: "http://example.com" })).toThrow(/https/);
    expect(githubApiBase({ COPILOT_AGENTS_GITHUB_API_BASE_URL: "http://127.0.0.1:4321/" })).toBe("http://127.0.0.1:4321");
    expect(githubApiBase({ COPILOT_AGENTS_GITHUB_API_BASE_URL: "http://[::1]:4321/" })).toBe("http://[::1]:4321");
    expect(githubApiBase({ COPILOT_AGENTS_GITHUB_API_BASE_URL: "https://api.github.com" })).toBe("https://api.github.com");
    expect(() => githubApiBase({ COPILOT_AGENTS_GITHUB_API_BASE_URL: "not-a-url" })).toThrow(/valid URL/);
  });

  it("requires Node.js 26", () => {
    expect(supportsNode("26.0.0")).toBe(true);
    expect(supportsNode("26.13.1")).toBe(true);
    expect(supportsNode("22.23.4")).toBe(false);
    expect(supportsNode("24.11.1")).toBe(false);
  });

  it("prefers the PAT and ignores GH_TOKEN and GITHUB_TOKEN", () => {
    expect(readActiveToken({
      GITHUB_PERSONAL_ACCESS_TOKEN: "from-pat",
      GH_TOKEN: "from-gh",
      GITHUB_TOKEN: "from-hub",
    }, () => {
      throw new Error("do not read the keyring");
    })).toBe("from-pat");
    expect(readActiveToken({ GH_TOKEN: "from-gh", GITHUB_TOKEN: "from-hub" }, () => "from-keyring")).toBe("from-keyring");
    expect(readActiveToken({ GITHUB_TOKEN: "from-hub" }, () => null)).toBeNull();
    expect(readActiveToken({ GITHUB_PERSONAL_ACCESS_TOKEN: "  " }, () => null)).toBeNull();
    const warning = ignoredTokenWarning({ GH_TOKEN: "from-gh", GITHUB_TOKEN: "from-hub" });
    expect(warning).toMatch(/GH_TOKEN/);
    expect(warning).toMatch(/GITHUB_TOKEN/);
    expect(warning).not.toContain("from-gh");
    expect(warning).not.toContain("from-hub");
    expect(ignoredTokenWarning({ GITHUB_PERSONAL_ACCESS_TOKEN: "from-pat", GH_TOKEN: "from-gh" })).toBeNull();
    expect(ignoredTokenWarning({})).toBeNull();
  });
});