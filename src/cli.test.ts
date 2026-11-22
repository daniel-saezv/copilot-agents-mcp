import { describe, expect, it } from "vitest";
import { parseArgs, readGitHubToken } from "./cli.ts";

describe("cli", () => {
  it("arranca en stdio y solo abre HTTP con el flag", () => {
    expect(parseArgs([], {})).toMatchObject({ command: "serve", http: false });
    expect(parseArgs(["--http"], {})).toMatchObject({ command: "serve", http: true, port: 3333 });
    expect(parseArgs(["--http", "--port", "4010"], {})).toMatchObject({ port: 4010 });
    expect(parseArgs(["watch"], {})).toEqual({ command: "watch" });
  });

  it("lee el token de la variable del MCP oficial y luego los alias", () => {
    expect(readGitHubToken({ GITHUB_PERSONAL_ACCESS_TOKEN: "uno", GH_TOKEN: "dos", GITHUB_TOKEN: "tres" })).toBe("uno");
    expect(readGitHubToken({ GH_TOKEN: "dos", GITHUB_TOKEN: "tres" })).toBe("dos");
    expect(readGitHubToken({ GITHUB_TOKEN: "tres" })).toBe("tres");
    expect(readGitHubToken({})).toBeNull();
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
