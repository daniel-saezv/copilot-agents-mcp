import { spawn, type SpawnOptions } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskNotice } from "./state.ts";

export const NOTIFY_URL_ENV = "COPILOT_AGENTS_NOTIFY_URL";
export const NOTIFY_AUTHORIZATION_ENV = "COPILOT_AGENTS_NOTIFY_AUTHORIZATION";

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
  await new Promise<void>((resolve) => {
    let pending = true;
    const done = (error?: unknown) => {
      if (!pending) return;
      pending = false;
      if (error === undefined) {
        resolve();
        return;
      }
      void appendWatcherLog(`Could not show the system notification: ${notifyFailure(plan.command, error)}`, baseEnv).finally(resolve);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl(plan.command, plan.args, { windowsHide: true, env: plan.env, stdio: "ignore" } satisfies SpawnOptions);
    } catch (error) {
      done(error);
      return;
    }
    child.on("error", (error) => done(error));
    child.on("exit", () => done());
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
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(notice),
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
): Promise<void> {
  await notifySystem(notice, spawnImpl, platform, env);
  const url = env[NOTIFY_URL_ENV]?.trim();
  if (!url) return;
  await postNotice(url, notice, env[NOTIFY_AUTHORIZATION_ENV]?.trim() || undefined, fetchImpl);
}

function publicEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_KEYS) {
    const value = baseEnv[key];
    if (value) env[key] = value;
  }
  return env;
}
