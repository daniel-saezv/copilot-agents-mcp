import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLocalStatusDiagnostics,
  envFlagSet,
  formatDbusDiagnostics,
  formatNotifyEnvDiagnostics,
  probeStateWritable,
} from "./status-local.ts";

const readonlyDirs: string[] = [];

afterEach(async () => {
  for (const dir of readonlyDirs.splice(0)) {
    await chmod(dir, 0o755).catch(() => undefined);
  }
});

function noSecrets(text: string, secrets: string[]): void {
  for (const secret of secrets) {
    expect(text).not.toContain(secret);
    if (secret.startsWith("Bearer ")) {
      expect(text).not.toContain(secret.slice("Bearer ".length));
    }
    try {
      const parsed = new URL(secret);
      expect(text).not.toContain(parsed.host);
      expect(text).not.toContain(parsed.pathname);
    } catch {
      // not a URL
    }
  }
}

describe("notify env diagnostics", () => {
  it("reports optional webhook when both vars are unset", () => {
    expect(formatNotifyEnvDiagnostics({})).toEqual(["  Info: webhook: not configured (optional)"]);
  });

  it("reports both set without warnings", () => {
    const secretUrl = "https://notify-host-7xkq99.example/webhook/segment-xy99";
    const secretAuth = "Bearer key-part-7xkq99-xy99";
    const lines = formatNotifyEnvDiagnostics({
      COPILOT_AGENTS_NOTIFY_URL: secretUrl,
      COPILOT_AGENTS_NOTIFY_AUTHORIZATION: secretAuth,
    });
    expect(lines).toEqual([
      "COPILOT_AGENTS_NOTIFY_URL: yes",
      "COPILOT_AGENTS_NOTIFY_AUTHORIZATION: yes",
    ]);
    noSecrets(lines.join("\n"), [secretUrl, secretAuth]);
  });

  it("warns when only the notify URL is set", () => {
    const secretUrl = "https://only-url-7xkq.example/hook/only99";
    const lines = formatNotifyEnvDiagnostics({ COPILOT_AGENTS_NOTIFY_URL: secretUrl });
    expect(lines[0]).toBe("COPILOT_AGENTS_NOTIFY_URL: yes");
    expect(lines[1]).toBe("COPILOT_AGENTS_NOTIFY_AUTHORIZATION: no");
    expect(lines[2]).toMatch(/Warning:.*COPILOT_AGENTS_NOTIFY_URL is set but COPILOT_AGENTS_NOTIFY_AUTHORIZATION is not/);
    noSecrets(lines.join("\n"), [secretUrl]);
  });

  it("warns when only authorization is set", () => {
    const secretAuth = "Bearer only-auth-7xkq99";
    const lines = formatNotifyEnvDiagnostics({ COPILOT_AGENTS_NOTIFY_AUTHORIZATION: secretAuth });
    expect(lines[0]).toBe("COPILOT_AGENTS_NOTIFY_URL: no");
    expect(lines[1]).toBe("COPILOT_AGENTS_NOTIFY_AUTHORIZATION: yes");
    expect(lines[2]).toMatch(/Warning:.*COPILOT_AGENTS_NOTIFY_AUTHORIZATION is set but COPILOT_AGENTS_NOTIFY_URL is not/);
    noSecrets(lines.join("\n"), [secretAuth]);
  });
});

describe("dbus diagnostics (info only)", () => {
  it("reports dbus unset with a linux info line", () => {
    const lines = formatDbusDiagnostics({}, "linux");
    expect(lines[0]).toBe("DBUS_SESSION_BUS_ADDRESS: no");
    expect(lines[1]).toMatch(/^  Info:/);
    expect(lines.join("\n")).not.toMatch(/Warning/i);
  });

  it("reports dbus set", () => {
    expect(formatDbusDiagnostics({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/bus" }, "linux")).toEqual([
      "DBUS_SESSION_BUS_ADDRESS: yes",
    ]);
  });

  it("omits the linux info line on other platforms", () => {
    expect(formatDbusDiagnostics({}, "darwin")).toEqual(["DBUS_SESSION_BUS_ADDRESS: no"]);
  });
});

describe("state writable probe", () => {
  it("passes when the state directory is writable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "status-local-ok-"));
    const statePath = join(dir, "state.json");
    const result = await probeStateWritable(statePath);
    expect(result.writable).toBe("ok");
  });

  it("fails when the state directory is not writable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "status-local-ro-"));
    readonlyDirs.push(dir);
    await chmod(dir, 0o444);
    expect((await probeStateWritable(join(dir, "state.json"))).writable).toBe("fail");
  });
});

describe("buildLocalStatusDiagnostics", () => {
  it("does not fail when webhook is optional and unset", async () => {
    const home = await mkdtemp(join(tmpdir(), "status-local-home-"));
    const { text, failed } = await buildLocalStatusDiagnostics(
      { COPILOT_AGENTS_STATE_PATH: join(home, "state.json") },
      { home, platform: "darwin" },
    );
    expect(failed).toBe(false);
    expect(text).toContain("Info: webhook: not configured (optional)");
    expect(text).not.toMatch(/Warning:/);
  });

  it("does not fail on one-sided notify config", async () => {
    const home = await mkdtemp(join(tmpdir(), "status-local-home-"));
    const { failed } = await buildLocalStatusDiagnostics(
      {
        COPILOT_AGENTS_STATE_PATH: join(home, "state.json"),
        COPILOT_AGENTS_NOTIFY_URL: "https://notify.example/hook",
      },
      { home },
    );
    expect(failed).toBe(false);
  });

  it("fails only when state paths are not writable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "status-local-report-ro-"));
    readonlyDirs.push(dir);
    await chmod(dir, 0o444);
    const statePath = join(dir, "state.json");
    const { text, failed } = await buildLocalStatusDiagnostics({ COPILOT_AGENTS_STATE_PATH: statePath });
    expect(failed).toBe(true);
    expect(text).toContain("writable: fail");
  });

  it("never prints notify secret values in the full report", async () => {
    const home = await mkdtemp(join(tmpdir(), "status-local-home-"));
    const secretUrl = "https://leak-host-7xkq.example/hook/leak99";
    const secretAuth = "Bearer leak-auth-7xkq99";
    const { text } = await buildLocalStatusDiagnostics(
      {
        COPILOT_AGENTS_NOTIFY_URL: secretUrl,
        COPILOT_AGENTS_NOTIFY_AUTHORIZATION: secretAuth,
        COPILOT_AGENTS_STATE_PATH: join(home, "state.json"),
      },
      { home, platform: "linux" },
    );
    expect(text).toContain("writable: ok");
    noSecrets(text, [secretUrl, secretAuth]);
  });
});

describe("envFlagSet", () => {
  it("uses presence only without inspecting values", () => {
    expect(envFlagSet({}, "FOO")).toBe(false);
    expect(envFlagSet({ FOO: "" }, "FOO")).toBe(false);
    expect(envFlagSet({ FOO: " " }, "FOO")).toBe(true);
    expect(envFlagSet({ FOO: "x" }, "FOO")).toBe(true);
  });
});