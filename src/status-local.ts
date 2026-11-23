import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { defaultStatePath } from "./state.ts";
import { NOTIFY_AUTHORIZATION_ENV, NOTIFY_URL_ENV } from "./notify.ts";

export type WritableProbe = "ok" | "fail";

export function stateLockDir(statePath: string): string {
  return `${statePath}.lock`;
}

export function envFlagSet(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "";
}

export function notifyAuthorizationWarnings(authorization: string): string[] {
  const trimmed = authorization.trim();
  if (!trimmed) return [];
  const warnings: string[] = [];
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    warnings.push(
      `${NOTIFY_AUTHORIZATION_ENV} looks like a URL; use the webhook URL only in ${NOTIFY_URL_ENV} and set this variable to Bearer <routine-key>.`,
    );
  }
  if (!trimmed.startsWith("Bearer ")) {
    warnings.push(`${NOTIFY_AUTHORIZATION_ENV} should start with \`Bearer \` followed by the routine Authorization key.`);
  }
  return warnings;
}

export function formatNotifyEnvDiagnostics(env: NodeJS.ProcessEnv): string[] {
  const lines = [
    `${NOTIFY_URL_ENV}: ${envFlagSet(env, NOTIFY_URL_ENV) ? "yes" : "no"}`,
    `${NOTIFY_AUTHORIZATION_ENV}: ${envFlagSet(env, NOTIFY_AUTHORIZATION_ENV) ? "yes" : "no"}`,
  ];
  const auth = env[NOTIFY_AUTHORIZATION_ENV];
  if (typeof auth === "string" && auth.trim()) {
    for (const warning of notifyAuthorizationWarnings(auth)) {
      lines.push(`  Warning: ${warning}`);
    }
  }
  return lines;
}

export function formatDbusDiagnostics(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  const set = envFlagSet(env, "DBUS_SESSION_BUS_ADDRESS");
  const lines = [`DBUS_SESSION_BUS_ADDRESS: ${set ? "yes" : "no"}`];
  if (!set && platform === "linux") {
    lines.push("  Hint: Without a session D-Bus, GitHub App login may fail; set DBUS_SESSION_BUS_ADDRESS or use GITHUB_PERSONAL_ACCESS_TOKEN.");
  }
  return lines;
}

export async function probeStateWritable(statePath: string): Promise<{ statePath: string; lockDir: string; writable: WritableProbe }> {
  const lockDir = stateLockDir(statePath);
  const parent = dirname(statePath);
  const fileProbe = `${statePath}.auth-status-probe`;
  const lockProbe = `${lockDir}.auth-status-probe`;
  try {
    await mkdir(parent, { recursive: true });
    await access(parent, constants.W_OK);
    await writeFile(fileProbe, "", { flag: "w" });
    await rm(fileProbe, { force: true });
    await mkdir(lockProbe);
    await rm(lockProbe, { recursive: true, force: true });
    return { statePath, lockDir, writable: "ok" };
  } catch {
    return { statePath, lockDir, writable: "fail" };
  }
}

export async function formatLocalStatusDiagnostics(
  env: NodeJS.ProcessEnv,
  options?: { home?: string; platform?: NodeJS.Platform },
): Promise<string> {
  const statePath = defaultStatePath(env, options?.home);
  const state = await probeStateWritable(statePath);
  const platform = options?.platform ?? process.platform;
  const lines = [
    "Local diagnostics:",
    `State file: ${state.statePath} — writable: ${state.writable}`,
    `State lock dir: ${state.lockDir} — writable: ${state.writable}`,
    ...formatNotifyEnvDiagnostics(env),
    ...formatDbusDiagnostics(env, platform),
  ];
  return lines.join("\n");
}