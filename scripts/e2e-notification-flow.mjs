import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { deliverNotice } from "../dist/notify.js";
import { readState, withStateLock, initialTask } from "../dist/state.js";
import { runWatcher } from "../dist/watch.js";

const dir = mkdtempSync(join(tmpdir(), "copilot-e2e-"));
const statePath = join(dir, "state.json");
const log = (line) => console.log(line);

const posts = [];
const hook = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    posts.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(204);
    res.end();
  });
});
await new Promise((resolve) => hook.listen(0, "127.0.0.1", resolve));
const hookUrl = `http://127.0.0.1:${hook.address().port}/notify`;
process.env.COPILOT_AGENTS_NOTIFY_URL = hookUrl;
process.env.COPILOT_AGENTS_LOG = join(dir, "watcher.log");

const github = {
  async createTask() {
    return { id: "e2e-task", state: "queued", created_at: "2026-11-23T00:00:00Z" };
  },
  async getTask() {
    return { id: "e2e-task", state: "completed", updated_at: "2026-11-23T00:05:00Z" };
  },
  async findPullRequest() {
    return null;
  },
  async getPullRequest() {
    throw new Error("unused");
  },
  async steerTask() {
    throw new Error("unused");
  },
  async abortTask() {
    throw new Error("unused");
  },
  async getTaskEvents() {
    throw new Error("unused");
  },
};

const deps = {
  statePath,
  clientForToken: () => github,
  readToken: () => "e2e-token",
  readModels: async () => {
    throw new Error("unused");
  },
  launchWatcher: () => {},
};

const mcp = buildServer({ exclude: [], readOnly: false, features: [] }, deps);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await mcp.connect(serverTransport);
const client = new Client({ name: "e2e", version: "0.0.0" });
await client.connect(clientTransport);
log(`instructions: ${client.getInstructions() ?? "(none)"}`);
const created = await client.callTool({
  name: "create_agent_task",
  arguments: { repo: "octocat/hello-world", prompt: "demo", model: "mai-code-2" },
});
log(`create_agent_task: ${created.content?.[0]?.text ?? JSON.stringify(created)}`);
await client.close();
await mcp.close();

await withStateLock(statePath, (state) => {
  state.tasks["e2e-task"] = initialTask({
    id: "e2e-task",
    repo: "octocat/hello-world",
    requestedModel: "mai-code-2",
    state: "in_progress",
    createdAt: "2026-11-23T00:00:00Z",
    updatedAt: "2026-11-23T00:00:00Z",
  });
});

await runWatcher({
  client: github,
  statePath,
  deliver: (notice) => deliverNotice(notice, process.env),
  intervalMs: 0,
  sleep: async () => {},
});
log(`webhook posts: ${posts.length}`);
log(`webhook body.state: ${posts[0]?.state ?? "missing"}`);

delete process.env.COPILOT_AGENTS_NOTIFY_URL;
const failDir = mkdtempSync(join(tmpdir(), "copilot-e2e-fail-"));
const failState = join(failDir, "state.json");
process.env.COPILOT_AGENTS_STATE_PATH = failState;
process.env.COPILOT_AGENTS_LOG = join(failDir, "fail.log");
await withStateLock(failState, (state) => {
  state.tasks["fail-task"] = initialTask({
    id: "fail-task",
    repo: "octocat/hello-world",
    requestedModel: "mai-code-2",
    state: "completed",
    createdAt: null,
    updatedAt: null,
  });
});
await runWatcher({
  client: { getTask: async () => ({ id: "fail-task", state: "completed" }), findPullRequest: async () => null },
  statePath: failState,
  deliver: (notice) => deliverNotice(notice, { PATH: "/usr/bin", COPILOT_AGENTS_LOG: process.env.COPILOT_AGENTS_LOG }, fetch, () => {
    const child = new EventEmitter();
    setImmediate(() => {
      const error = new Error("spawn notify-send ENOENT");
      error.code = "ENOENT";
      child.emit("error", error);
    });
    return child;
  }, "linux"),
  intervalMs: 0,
  sleep: async () => {},
});
const failed = await readState(failState);
log(`failed delivery notified_at: ${failed.tasks["fail-task"]?.notified_at ?? "null"}`);
log(`failed delivery record: ${JSON.stringify(failed.tasks["fail-task"]?.delivery)}`);

hook.close();
rmSync(dir, { recursive: true, force: true });
rmSync(failDir, { recursive: true, force: true });