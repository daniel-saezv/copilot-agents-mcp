import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");
const node = process.execPath;

if (!process.version.startsWith("v26")) {
  console.error(`Node.js 26 or later is required. Found ${process.versions.node}.`);
  process.exit(1);
}

const createdFixture = JSON.parse(readFileSync(join(root, "fixtures/openapi/create-task.response.json"), "utf8")).example;
const taskId = "e2e-stdio-task";

function log(line) {
  console.log(line);
}

function textOf(result) {
  const first = result.content?.[0];
  return first && typeof first === "object" && "text" in first && typeof first.text === "string" ? first.text : "";
}

async function connectMcp(env) {
  const transport = new StdioClientTransport({
    command: node,
    args: [cli],
    env: { ...process.env, ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "e2e-stdio", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function callTool(client, name, args) {
  return client.callTool({ name, arguments: args });
}

function startFakeGitHub() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/agents/repos/octocat/hello-world/tasks") {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({
          ...createdFixture,
          id: taskId,
          state: "queued",
          created_at: "2026-11-23T00:00:00Z",
        }));
        return;
      }
      if (req.method === "GET" && url.pathname === `/agents/repos/octocat/hello-world/tasks/${taskId}`) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: taskId,
          state: "completed",
          created_at: "2026-11-23T00:00:00Z",
          updated_at: "2026-11-23T00:05:00Z",
          sessions: [{
            id: "session-e2e",
            state: "completed",
            created_at: "2026-11-23T00:00:01Z",
            completed_at: "2026-11-23T00:05:00Z",
          }],
        }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Not Found", path: url.pathname }));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

function startWebhook() {
  const posts = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      posts.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(204);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}/notify`,
        posts,
      });
    });
  });
}

async function waitFor(predicate, label, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await Promise.resolve(predicate())) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

const notifyBin = mkdtempSync(join(tmpdir(), "copilot-e2e-bin-"));
const notifySend = join(notifyBin, "notify-send");
writeFileSync(notifySend, "#!/bin/sh\n");
chmodSync(notifySend, 0o755);
const pathWithNotify = `${notifyBin}:${process.env.PATH ?? ""}`;

const workDir = mkdtempSync(join(tmpdir(), "copilot-e2e-stdio-"));
const github = await startFakeGitHub();
const webhook = await startWebhook();

try {
  const statePath = join(workDir, "state-webhook.json");
  const shared = {
    GITHUB_PERSONAL_ACCESS_TOKEN: "e2e-token",
    COPILOT_AGENTS_GITHUB_API_BASE_URL: github.base,
    COPILOT_AGENTS_STATE_PATH: statePath,
    COPILOT_AGENTS_NOTIFY_URL: webhook.url,
    COPILOT_AGENTS_POLL_INTERVAL_MS: "200",
    PATH: pathWithNotify,
  };

  const { client } = await connectMcp(shared);
  log(`instructions: ${client.getInstructions() ?? "(none)"}`);
  const started = performance.now();
  const created = await callTool(client, "create_agent_task", {
    repo: "octocat/hello-world",
    prompt: "e2e stdio demo",
    model: "mai-code-2",
  });
  const createMs = Math.round(performance.now() - started);
  const createBody = JSON.parse(textOf(created));
  log(`create_agent_task_ms: ${createMs}`);
  log(`create_agent_task_notification_channels: ${createBody.notification.channels.join(", ")}`);
  if (createMs >= 1000) throw new Error(`create_agent_task took ${createMs} ms (limit 1000).`);

  await waitFor(() => webhook.posts.length === 1, "one webhook POST");
  log(`webhook_post_count: ${webhook.posts.length}`);
  log(`webhook_post_state: ${webhook.posts[0]?.state ?? "missing"}`);

  const status = await callTool(client, "get_agent_task", { task_id: taskId, repo: "octocat/hello-world" });
  const statusBody = JSON.parse(textOf(status));
  log(`get_agent_task_notified_after_webhook: ${statusBody.notified}`);
  await client.close();

  const failDir = mkdtempSync(join(tmpdir(), "copilot-e2e-fail-"));
  const failState = join(failDir, "state-fail.json");
  const failGithub = await startFakeGitHub();
  try {
    const failEnv = {
      GITHUB_PERSONAL_ACCESS_TOKEN: "e2e-token",
      COPILOT_AGENTS_GITHUB_API_BASE_URL: failGithub.base,
      COPILOT_AGENTS_STATE_PATH: failState,
      COPILOT_AGENTS_POLL_INTERVAL_MS: "200",
      PATH: "/nonexistent",
    };
    const failClient = await connectMcp(failEnv);
    await callTool(failClient.client, "create_agent_task", {
      repo: "octocat/hello-world",
      prompt: "e2e fail delivery",
      model: "mai-code-2",
    });
    await waitFor(async () => {
      const row = await callTool(failClient.client, "get_agent_task", { task_id: taskId, repo: "octocat/hello-world" });
      const body = JSON.parse(textOf(row));
      return body.state === "completed" && body.notified === false;
    }, "get_agent_task notified false after failed delivery");
    const failed = JSON.parse(textOf(await callTool(failClient.client, "get_agent_task", { task_id: taskId, repo: "octocat/hello-world" })));
    log(`failed_delivery_get_agent_task_notified: ${failed.notified}`);
    log(`failed_delivery_state: ${failed.state}`);
    await failClient.client.close();
    failGithub.server.close();
  } finally {
    rmSync(failDir, { recursive: true, force: true });
  }
} finally {
  webhook.server.close();
  github.server.close();
  rmSync(workDir, { recursive: true, force: true });
}