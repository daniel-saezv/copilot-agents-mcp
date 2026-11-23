import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { webhookPayloadId } from "./delivery.ts";
import { mapRawState } from "./task-status.ts";
import type { TaskNotice } from "./state.ts";

export const NOTIFY_URL_ENV = "COPILOT_AGENTS_NOTIFY_URL";
export const NOTIFY_AUTHORIZATION_ENV = "COPILOT_AGENTS_NOTIFY_AUTHORIZATION";

export type NotifyChannel = "system" | "webhook";

export type DeliveredNotice = {
  channels: NotifyChannel[];
};

const ENV_KEYS = ["PATH", "SystemRoot", "WINDIR", "PATHEXT", "DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "HOME"];

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$title = $env:COPILOT_AGENTS_NOTIFY_TITLE
$body = $env:COPILOT_AGENTS_NOTIFY_BODY
try {
  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  $escapedTitle = [System.Security.SecurityElement]::Escape($title)
  $escapedBody = [System.Security.SecurityElement]::Escape($body)
  $template = "<toast><visual><binding template='ToastGeneric'><text>$escapedTitle</text><text>$escapedBody</text></binding></visual></toast>"
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml($template)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('PowerShell').Show($toast)
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $icon = New-Object System.Windows.Forms.NotifyIcon
  $icon.Icon = [System.Drawing.SystemIcons]::Information
  $icon.Visible = $true
  $icon.ShowBalloonTip(8000, $title, $body, [System.Windows.Forms.ToolTipIcon]::Info)
  Start-Sleep -Seconds 2
  $icon.Dispose()
}
`.trim();

export type NotificationPlan = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

export function systemNotifierAvailable(platform: NodeJS.Platform, baseEnv: NodeJS.ProcessEnv): boolean {
  const plan = notificationPlan(platform, "", "", baseEnv);
  if (!plan) return false;
  return commandOnPath(plan.command, baseEnv, platform);
}

export function activeNotificationChannels(platform: NodeJS.Platform, baseEnv: NodeJS.ProcessEnv): NotifyChannel[] {
  const channels: NotifyChannel[] = [];
  if (systemNotifierAvailable(platform, baseEnv)) channels.push("system");
  if (baseEnv[NOTIFY_URL_ENV]?.trim()) channels.push("webhook");
  return channels;
}

export function createNextStep(channels: NotifyChannel[]): string {
  if (channels.length === 0) {
    return "Task queued. Do not poll. End your turn; no notification channel is configured (set COPILOT_AGENTS_NOTIFY_URL). Call get_agent_task once later.";
  }
  const via = channels.length === 1 ? channels[0] ?? "system" : `${channels.slice(0, -1).join(", ")} and ${channels.at(-1) ?? ""}`;
  return `Task queued. Do not poll. End your turn; you will be notified via ${via}. Call get_agent_task once later.`;
}

export function notificationPlan(platform: NodeJS.Platform, title: string, body: string, baseEnv: NodeJS.ProcessEnv): NotificationPlan | null {
  const env = publicEnv(baseEnv);
  env.COPILOT_AGENTS_NOTIFY_TITLE = title;
  env.COPILOT_AGENTS_NOTIFY_BODY = body;
  if (platform === "win32") return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT], env };
  if (platform === "darwin") {
    return {
      command: "osascript",
      args: ["-e", 'display notification (system attribute "COPILOT_AGENTS_NOTIFY_BODY") with title (system attribute "COPILOT_AGENTS_NOTIFY_TITLE")'],
      env,
    };
  }
  if (platform === "linux") return { command: "notify-send", args: ["--", title, body], env };
  return null;
}

export function noticeText(notice: TaskNotice): { title: string; body: string } {
  const title = `Copilot ${notice.state}`.slice(0, 80);
  const body = [notice.repo, notice.task_id, notice.error ?? notice.state].filter(Boolean).join("\n").slice(0, 240);
  return { title, body };
}

export async function notifySystem(notice: TaskNotice, spawnImpl: typeof spawn = spawn, platform: NodeJS.Platform = process.platform, baseEnv: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { title, body } = noticeText(notice);
  const plan = notificationPlan(platform, title, body, baseEnv);
  if (!plan) return;
  await new Promise<void>((resolve, reject) => {
    let pending = true;
    const fail = (message: string) => {
      void appendWatcherLog(`Could not show the system notification: ${message}`, baseEnv).finally(() => {
        reject(new Error(message));
      });
    };
    const done = (error?: unknown, exitCode?: number | null) => {
      if (!pending) return;
      pending = false;
      if (error === undefined && exitCode === 0) {
        resolve();
        return;
      }
      if (error === undefined && exitCode === null) {
        fail(`signal ${plan.command}`);
        return;
      }
      if (error !== undefined) {
        fail(notifyFailure(plan.command, error));
        return;
      }
      fail(`exit ${exitCode ?? "?"} ${plan.command}`);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl(plan.command, plan.args, { windowsHide: true, env: plan.env, stdio: "ignore" } satisfies SpawnOptions);
    } catch (error) {
      done(error);
      return;
    }
    child.on("error", (error) => done(error));
    child.on("exit", (code) => done(undefined, code));
  });
}

export async function appendWatcherLog(line: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const logPath = env.COPILOT_AGENTS_LOG?.trim();
  if (!logPath) {
    console.error(line);
    return;
  }
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${line}\n`, "utf8");
  } catch {
    console.error(line);
  }
}

function notifyFailure(command: string, error: unknown): string {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "error";
  return `${code} ${command}`;
}

export async function postNotice(url: string, notice: TaskNotice, authorization: string | undefined, fetchImpl: typeof fetch = fetch): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization) headers.authorization = authorization;
  const mapped = mapRawState(notice.state);
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...notice, status: mapped.status, terminal: mapped.terminal, id: webhookPayloadId(notice.task_id, notice.state) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Notification POST returned HTTP ${response.status}.`);
}

export async function deliverNotice(
  notice: TaskNotice,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  spawnImpl: typeof spawn = spawn,
  platform: NodeJS.Platform = process.platform,
): Promise<DeliveredNotice> {
  const channels: NotifyChannel[] = [];
  if (systemNotifierAvailable(platform, env)) {
    try {
      await notifySystem(notice, spawnImpl, platform, env);
      channels.push("system");
    } catch {
      /* logged in notifySystem */
    }
  }
  const url = env[NOTIFY_URL_ENV]?.trim();
  if (url) {
    try {
      await postNotice(url, notice, env[NOTIFY_AUTHORIZATION_ENV]?.trim() || undefined, fetchImpl);
      channels.push("webhook");
    } catch (error) {
      const message = error instanceof Error ? error.message : "webhook delivery failed";
      await appendWatcherLog(`Could not POST the task notification: ${message}`, env);
    }
  }
  return { channels };
}

function commandOnPath(command: string, baseEnv: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    const systemRoot = baseEnv.SystemRoot ?? baseEnv.WINDIR ?? "C:\\Windows";
    const candidate = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", command);
    if (existsSync(candidate)) return true;
  }
  const pathList = baseEnv.PATH ?? "";
  for (const dir of pathList.split(delimiter)) {
    if (!dir) continue;
    if (existsSync(join(dir, command))) return true;
  }
  return false;
}

function publicEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_KEYS) {
    const value = baseEnv[key];
    if (value) env[key] = value;
  }
  return env;
}
