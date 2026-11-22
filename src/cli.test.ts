import { describe, expect, it } from "vitest";
import { ignoredTokenWarning, readActiveToken } from "./auth.ts";
import { parseArgs } from "./cli.ts";

describe("cli", () => {
  it("arranca en stdio y solo abre HTTP con el flag", () => {
    expect(parseArgs([], {})).toMatchObject({ command: "serve", http: false });
    expect(parseArgs(["--http"], {})).toMatchObject({ command: "serve", http: true, port: 3333 });
    expect(parseArgs(["--http", "--port", "4010"], {})).toMatchObject({ port: 4010 });
    expect(parseArgs(["watch"], {})).toEqual({ command: "watch" });
    expect(parseArgs(["login"], {})).toEqual({ command: "login" });
    expect(parseArgs(["logout"], {})).toEqual({ command: "logout" });
    expect(parseArgs(["auth", "status"], {})).toEqual({ command: "status" });
    expect(parseArgs(["--version"], {})).toEqual({ command: "version" });
    expect(() => parseArgs(["auth"], {})).toThrow(/auth status/);
    expect(() => parseArgs(["login", "--http"], {})).toThrow(/no admite/);
  });

  it("prioriza el PAT y no usa GH_TOKEN ni GITHUB_TOKEN", () => {
    expect(readActiveToken({
      GITHUB_PERSONAL_ACCESS_TOKEN: "from-pat",
      GH_TOKEN: "from-gh",
      GITHUB_TOKEN: "from-hub",
    }, () => {
      throw new Error("no leas el llavero");
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

  it("toma toolsets de flags o del entorno", () => {
    expect(parseArgs(["--toolsets", "copilot_models", "--read-only"], {})).toMatchObject({
      selection: { toolsets: ["copilot_models"], readOnly: true, features: [] },
    });
    expect(parseArgs([], { GITHUB_TOOLSETS: "copilot_tasks", GITHUB_READ_ONLY: "true" })).toMatchObject({
      selection: { toolsets: ["copilot_tasks"], readOnly: true },
    });
    expect(() => parseArgs(["--features", "agent_automations", "--toolsets", "copilot_automations"], {})).not.toThrow();
    expect(() => parseArgs(["--toolsets", "copilot_automations"], {})).toThrow(/agent_automations/);
  });
});
