import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  envFlagSet,
  formatDbusDiagnostics,
  formatLocalStatusDiagnostics,
  formatNotifyEnvDiagnostics,
  notifyAuthorizationWarnings,
  probeStateWritable,
} from "./status-local.ts";

const readonlyDirs: string[] = [];

afterEach(async () => {
  for (const dir of readonlyDirs.splice(0)) {
    await chmod(dir, 0o755).catch(() => undefined);
  }
});

describe("notify env diagnostics", () => {
  it("reports unset notify variables", () => {
    const lines = formatNotifyEnvDiagnostics({});
    expect(lines).toEqual([
      "COPILOT_AGENTS_NOTIFY_URL: no",
      "COPILOT_AGENTS_NOTIFY_AUTHORIZATION: no",
    ]);
  });

  it("reports set notify variables without printing values", () => {
    const secretUrl = "https://notify.example/hook/SECRET_URL_TOKEN";
    const secretAuth = "Bearer SECRET_AUTH_KEY_XYZ";
    const lines = formatNotifyEnvDiagnostics({
      COPILOT_AGENTS_NOTIFY_URL: secretUrl,
      COPILOT_AGENTS_NOTIFY_AUTHORIZATION: secretAuth,
    });
    expect(lines[0]).toBe("COPILOT_AGENTS_NOTIFY_URL: yes");
    expect(lines[1]).toBe("COPILOT_AGENTS_NOTIFY_AUTHORIZATION: yes");
    expect(lines.join("\n")).not.toContain(secretUrl);
    expect(lines.join("\n")).not.toContain(secretAuth);
    expect(lines.join("\n")).not.toContain("SECRET_URL_TOKEN");
    expect(lines.join("\n")).not.toContain("SECRET_AUTH_KEY_XYZ");
  });

  it("warns when authorization looks like a URL", () => {
    const warnings = notifyAuthorizationWarnings("https://example.com/hook");
    expect(warnings.some((line) => line.includes("looks like a URL"))).toBe(true);
    const lines = formatNotifyEnvDiagnostics({
      COPILOT_AGENTS_NOTIFY_AUTHORIZATION: "http://localhost:9/hook",
    });
    expect(lines.some((line) => line.includes("Warning:") && line.includes("looks like a URL"))).toBe(true);
    expect(lines.join("\n")).not.toContain("localhost:9");
  });

  it("warns when authorization lacks the Bearer prefix", () => {
    const warnings = notifyAuthorizationWarnings("plain-key-only");
    expect(warnings.some((line) => line.includes("Bearer "))).toBe(true);
    const lines = formatNotifyEnvDiagnostics({
      COPILOT_AGENTS_NOTIFY_AUTHORIZATION: "plain-key-only",
    });
    expect(lines.some((line) => line.includes("Warning:") && line.includes("Bearer "))).toBe(true);
    expect(lines.join("\n")).not.toContain("plain-key-only");
  });

  it("accepts a well-formed Bearer authorization without warnings", () => {
    expect(notifyAuthorizationWarnings("Bearer routine-key")).toEqual([]);
    const lines = formatNotifyEnvDiagnostics({
      COPILOT_AGENTS_NOTIFY_AUTHORIZATION: "Bearer routine-key",
    });
    expect(lines).toEqual(["COPILOT_AGENTS_NOTIFY_URL: no", "COPILOT_AGENTS_NOTIFY_AUTHORIZATION: yes"]);
  });
});

describe("dbus diagnostics", () => {
  it("shows a linux hint when DBUS is unset", () => {
    const lines = formatDbusDiagnostics({}, "linux");
    expect(lines[0]).toBe("DBUS_SESSION_BUS_ADDRESS: no");
    expect(lines[1]).toMatch(/D-Bus/i);
  });

  it("reports dbus set without a hint", () => {
    const lines = formatDbusDiagnostics({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/bus" }, "linux");
    expect(lines).toEqual(["DBUS_SESSION_BUS_ADDRESS: yes"]);
  });

  it("skips the linux hint on other platforms", () => {
    expect(formatDbusDiagnostics({}, "darwin")).toEqual(["DBUS_SESSION_BUS_ADDRESS: no"]);
  });
});

describe("state writable probe", () => {
  it("passes when the state directory is writable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "status-local-ok-"));
    const statePath = join(dir, "state.json");
    const result = await probeStateWritable(statePath);
    expect(result.writable).toBe("ok");
    expect(result.statePath).toBe(statePath);
    expect(result.lockDir).toBe(`${statePath}.lock`);
  });

  it("fails when the state directory is not writable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "status-local-ro-"));
    readonlyDirs.push(dir);
    await chmod(dir, 0o444);
    const statePath = join(dir, "state.json");
    const result = await probeStateWritable(statePath);
    expect(result.writable).toBe("fail");
  });
});

describe("formatLocalStatusDiagnostics", () => {
  it("never prints notify secret values in the full report", async () => {
    const home = await mkdtemp(join(tmpdir(), "status-local-home-"));
    const secretUrl = "https://notify.example/hook/LEAK_URL";
    const secretAuth = "Bearer LEAK_AUTH_VALUE";
    const text = await formatLocalStatusDiagnostics(
      {
        COPILOT_AGENTS_NOTIFY_URL: secretUrl,
        COPILOT_AGENTS_NOTIFY_AUTHORIZATION: secretAuth,
        COPILOT_AGENTS_STATE_PATH: join(home, "state.json"),
      },
      { home, platform: "linux" },
    );
    expect(text).toContain("Local diagnostics:");
    expect(text).toContain("writable: ok");
    expect(text).not.toContain(secretUrl);
    expect(text).not.toContain(secretAuth);
    expect(text).not.toContain("LEAK_URL");
    expect(text).not.toContain("LEAK_AUTH_VALUE");
  });

  it("reports state writable fail in the full report", async () => {
    const dir = await mkdtemp(join(tmpdir(), "status-local-report-ro-"));
    readonlyDirs.push(dir);
    await chmod(dir, 0o444);
    const statePath = join(dir, "state.json");
    const text = await formatLocalStatusDiagnostics(
      { COPILOT_AGENTS_STATE_PATH: statePath },
      { platform: "darwin" },
    );
    expect(text).toContain(`State file: ${statePath} — writable: fail`);
    expect(text).toContain(`State lock dir: ${statePath}.lock — writable: fail`);
  });
});

describe("envFlagSet", () => {
  it("treats whitespace-only values as unset", () => {
    expect(envFlagSet({ FOO: "  " }, "FOO")).toBe(false);
    expect(envFlagSet({ FOO: "x" }, "FOO")).toBe(true);
  });
});