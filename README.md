<p align="center">
  <img src="https://raw.githubusercontent.com/daniel-saezv/copilot-agents-mcp/main/assets/logo.svg" width="128" alt="copilot-agents-mcp">
</p>

# copilot-agents-mcp

Local [Model Context Protocol](https://modelcontextprotocol.io/) server for launching and managing GitHub Copilot **cloud agent** tasks. It speaks MCP over **stdio only** and runs on your machine (Node.js **26+**).

```mermaid
flowchart LR
  C[MCP client] -->|stdio| M[copilot-agents-mcp]
  M -->|GitHub App device flow or PAT| A[GitHub authentication]
  M -->|Agent tasks API| G[GitHub]
  M --> N[Local state and watcher]
  N -->|optional POST webhook| W[Your receiver]
```

## Requirements

- **Node.js 26** or later (`engines.node` in `package.json`).
- GitHub credentials: GitHub App **login** (preferred) or `GITHUB_PERSONAL_ACCESS_TOKEN`.

## Authentication

```bash
npx -y github:daniel-saezv/copilot-agents-mcp login
npx -y github:daniel-saezv/copilot-agents-mcp auth status
```

Complete the device flow in the browser. `auth status` shows the active credential without printing tokens, then **local diagnostics** (no network, never reading notify secret values): state file and lock directory writability (non-writable → exit code 1); webhook env set yes/no only (both unset → info: optional; exactly one set → warning); `DBUS_SESSION_BUS_ADDRESS` yes/no plus an info line on Linux when unset. Optional webhook and notify warnings do not change the exit code. Alternatively set `GITHUB_PERSONAL_ACCESS_TOKEN` in the MCP server process environment (never commit tokens in project config).

Optional: `COPILOT_AGENTS_GITHUB_APP_CLIENT_ID`, `COPILOT_AGENTS_GITHUB_API_BASE_URL` (GitHub Enterprise).

## Environment variables

| Variable | Purpose |
| --- | --- |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | PAT; takes precedence over keyring session |
| `COPILOT_AGENTS_NOTIFY_URL` | Webhook URL; watcher POSTs JSON when a task finishes |
| `COPILOT_AGENTS_NOTIFY_AUTHORIZATION` | Literal `Authorization` header on the notify POST: `Bearer <routine-key>` (not the webhook URL) |
| `COPILOT_AGENTS_STATE_PATH` | Isolated state file (default `~/.copilot-agents-mcp/state.json`) |
| `COPILOT_AGENTS_LOG` | Optional watcher log file |
| `COPILOT_AGENTS_GITHUB_API_BASE_URL` | Enterprise API base |
| `DBUS_SESSION_BUS_ADDRESS` | On headless Linux, points the OS keyring (`secret-service`) at the session bus (e.g. `unix:path=/tmp/xdg-runtime-box/bus` on a Grok Bot box). If unset and login fails, use `GITHUB_PERSONAL_ACCESS_TOKEN` instead |

Watcher poll interval and task freshness are **fixed internally** (15s poll, 60s freshness).

## Tools

<!-- START AUTOMATED TOOLS -->
| Tool | Read-only | Description |
| --- | --- | --- |
| `create_agent_task` | no | Launch a GitHub Copilot cloud agent with repo, prompt, and model; use list_copilot_models to discover IDs. Returns status, delivery, follow_up, and next_step. May fail for authentication, repository access or policy, invalid input, or an unavailable model; previously rejected models skip the API and list accepted models observed so far. Returns immediately with task_id. Follow next_step. If setup is present, ask once and record the answer with set_completion_strategy. |
| `get_agent_task` | yes | Read one task's result by task_id; optional repo overrides the saved repository and verbose adds details. Returns status, terminal, summary, delivery, and available PR/session links. Cached results may include stale and warnings after a refresh failure. Check authentication or task/repository access on errors. Use list_agent_tasks for scheduled checks, never call this in a loop. |
| `list_agent_tasks` | yes | Check locally tracked tasks in one scheduled call, filtered by owner, task_ids, status, or repo. Returns compact rows (limit defaults to 20, maximum 50), counts across all matches, all_terminal, next_step, and next_check_after while pending. Stop checks when all_terminal is true. Refresh failures return stale rows and warnings; pending tasks require authentication. Owner is a read-only label, not authentication; this is not a GitHub-wide task search. If setup is present, ask once and record the answer with set_completion_strategy. |
| `steer_agent_task` | no | [Experimental] Undocumented internal GitHub endpoint that can change without notice. Send content to task_id when continuing or redirecting a task with an open pull request. Owned tasks require their matching owner_token. Each call consumes credits and is not idempotent; the agent applies it after its current tool call. Returns task_id, accepted, and the pre-steer session_count, then watches the new turn when notifications are configured. Errors explain missing authentication, repository, or an absent/closed pull request. |
| `abort_agent_task` | no | [Experimental] Undocumented internal GitHub endpoint that can change without notice. Request cancellation of task_id via the internal steer endpoint; not verified against live GitHub. Owned tasks require their matching owner_token. Use only to stop work, not to read status. Returns accepted, status, and terminal; accepted=false with reason when already finished. Acceptance does not mean cancellation has completed. Check authentication and task access on errors. |
| `list_copilot_models` | yes | Discover model IDs before create_agent_task. Reads /agents/swe/models and returns source metadata plus models with ID, name, vendor, preview, token prices or billing multiplier, and optional promotion/policy. No parameters. Availability remains subject to repository policy. Errors explain missing authentication, upstream access/network failures, or an invalid upstream response. |
| `set_completion_strategy` | no | Save the user's completion choice: webhook (recommended) or check_later. Webhook setup stays in the local CLI; never pass URLs or secrets through MCP. For webhook, the receiver must wake the agent that owns the task live—silent or muted handlers miss completions or deliver them late; see Platform notes in the README. Returns strategy and next_step. |
<!-- END AUTOMATED TOOLS -->

After `create_agent_task`, end your turn. The server returns `follow_up` and `next_step`: either rely on a webhook that wakes the owning agent live, or schedule `list_agent_tasks` (not before `check_after`).

Version **0.3.0** replaces free-text owner identity with a CLI-minted `owner_token` and adds `set_completion_strategy`. Every tool advertises an output schema and returns matching JSON text and `structuredContent`. See [migration steps](CHANGELOG.md#migration-from-020) and [tool contracts and error codes](docs/tools.md).

On the first unconfigured creation or list call, a non-error `setup` field asks how the user wants follow-up. Ask in the user's current language, preserving its canonical English intent, then record `webhook` (recommended) or `check_later` with `set_completion_strategy`. The choice and one-time ask are remembered per owner (or `_default` for unowned calls). Creation never blocks; without a notification channel, schedule the first check after about ten minutes and later checks no more often than every five minutes. This works even when clients ignore server instructions or decline forms.

## Client setup

Run the same stdio command everywhere:

```json
{
  "command": "npx",
  "args": ["-y", "github:daniel-saezv/copilot-agents-mcp"]
}
```

### (a) Grok Bot

For a shared connector, use [per-client webhooks](#optional-per-client-webhooks) and separate private owner tokens. The environment-based routine below is only the global fallback; identical connector environments cannot identify individual agents.

1. Add a **local stdio MCP server** with the command and args above.
2. Optional: set `COPILOT_AGENTS_STATE_PATH` in the server environment so this bot does not share state with other agents.
3. On headless Linux, set `DBUS_SESSION_BUS_ADDRESS` (for example `unix:path=/tmp/xdg-runtime-box/bus`) so GitHub App `login` can use the keyring; otherwise set `GITHUB_PERSONAL_ACCESS_TOKEN` in the server env.
4. **Webhook routine (recommended):** Create a **Routine** with a **Webhook** trigger in the Grok Bot UI. The **human who owns the routine** configures the MCP server’s masked secret fields; the bot cannot read those values itself. Set `COPILOT_AGENTS_NOTIFY_URL` to the routine’s **webhook URL** from the panel (`https://…`).
5. Set `COPILOT_AGENTS_NOTIFY_AUTHORIZATION` to the literal string `Bearer <routine-key>`: the word `Bearer` exactly once, one space, then the routine’s **Authorization key** from the panel. The server sends this value verbatim as the HTTP `Authorization` header. Do **not** paste the webhook URL here—that belongs only in `COPILOT_AGENTS_NOTIFY_URL`.
6. Configure routine delivery per [Grok Bot](#grok-bot) in Platform notes so the owning bot wakes (`deliverTo = app_chat`, not `none`).
7. When a Copilot task reaches a terminal state, the background watcher POSTs JSON to the routine; the bot can wake and call `get_agent_task` once. Without the webhook, follow the `check_later` text in `next_step`.

### (b) Claude Code and Claude Desktop

**Claude Code:**

```bash
claude mcp add --transport stdio copilot-agents -- npx -y github:daniel-saezv/copilot-agents-mcp
```

For a PAT: add `-e GITHUB_PERSONAL_ACCESS_TOKEN=…` (stored in your private `~/.claude.json`).

**Claude Desktop:** user-level `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "copilot-agents": {
      "command": "npx",
      "args": ["-y", "github:daniel-saezv/copilot-agents-mcp"]
    }
  }
}
```

### (c) Cursor

`~/.cursor/mcp.json` (global) or project `.cursor/mcp.json` (no secrets in committed project files):

```json
{
  "mcpServers": {
    "copilot-agents": {
      "command": "npx",
      "args": ["-y", "github:daniel-saezv/copilot-agents-mcp"]
    }
  }
}
```

### (d) Generic `npx` / any MCP client

Point stdio transport at `npx -y github:daniel-saezv/copilot-agents-mcp`. Pass auth and notification env vars in the client’s server environment.

## Watch tasks

```bash
npx -y github:daniel-saezv/copilot-agents-mcp watch
```

`create_agent_task` also starts a detached watcher when an eligible owner webhook or `COPILOT_AGENTS_NOTIFY_URL` is configured. The watcher polls pending tasks, updates local state under a directory lock, and records completion delivery.

Several agents can share one connector and identical server environment. Pass each agent's private `owner_token` on create, steer, abort, and `set_completion_strategy`; filter `list_agent_tasks` by its label-style `owner`. That read filter is not identity. No environment variable, client name, or session identifies an owner.

## Optional per-client webhooks

A webhook is the **RECOMMENDED** completion path. `check_later` is the supported fallback: end the turn, schedule a check at `check_after` if possible, never poll in a loop. Record the user's choice with `set_completion_strategy`; selecting `webhook` returns the local CLI next step, not a form for secrets. Registration is local CLI configuration, not an MCP tool:

```bash
copilot-agents-mcp webhook register --owner client-1 --token-out /private/path/client-1-token
copilot-agents-mcp webhook list
copilot-agents-mcp auth status
copilot-agents-mcp webhook remove --owner client-1 --token-file /private/path/client-1-token
```

Registration reads the URL and complete `Authorization` header value through hidden terminal prompts. Alternatively, supply private input files with `--url-file /path/to/url-file --auth-file /path/to/auth-file`. Never put either secret in argv, environment variables for this command, or chat. Keep input files private and remove them when no longer needed.

Owner labels use 1–64 characters from `[A-Za-z0-9._-]`; `_default` is reserved for unowned completion preferences.

Registration mints `owner_token` (`cam_ot_` plus 32 random bytes encoded as base64url). Without `--token-out`, it is shown once on stdout; with that flag it is written only to a new mode `0600` file using exclusive creation. Store it privately and pass it as `owner_token` on `create_agent_task`, `steer_agent_task`, `abort_agent_task`, and `set_completion_strategy`. The server stores only its SHA-256 hash and resolves the exact, case-sensitive owner with constant-time hash comparison. Tool results and logs never echo it.

Replacing or removing an owner requires the current token via `--token-file` or a hidden prompt. Re-registering rotates the token; use a new `--token-out` path and update the agent's private token. Removal revokes the token's tool identity and deletes the webhook credentials, but retains a hash-only reservation so another agent cannot claim that label and steer its tasks. Keep the old token for re-registration, or use local recovery.

`--force-replace` bypasses the old-token check only in a local terminal, for recovery or migration of 0.2.0 registrations. Legacy registrations are flagged by `webhook list` and `auth status` and must be re-registered. All clients and the watcher must share `COPILOT_AGENTS_STATE_PATH` (default `~/.copilot-agents-mcp/state.json`). This protects tool-level identity and accidental CLI hijacks, not against a process that can directly edit private local state.

No token on creation means an unowned task, retaining global notification fallback or scheduled checks. An invalid token, or a missing/mismatched token when steering or aborting an owned task, returns `owner_token_invalid` before mutation, leaving the task untouched with no routing or global fallback. Unowned tasks can be aborted without a token. `owner` is no longer accepted on creation.

An owner's recorded `check_later` choice suppresses its notifications; `webhook` restores eligible delivery. `_default` preferences do not disable the global environment fallback for unowned tasks.

The registry stores the URL, registration time, token hash, and key file path in locked local state; the Authorization value lives separately in a mode `0600` file named `sha256(owner)` beside that state. `webhook list` and `auth status` show safe registration diagnostics and whether re-registration is needed, never the URL path/query, token, or Authorization value.

Only tasks created **after** registration route to that owner. Other tasks retain the existing global `COPILOT_AGENTS_NOTIFY_URL` / `COPILOT_AGENTS_NOTIFY_AUTHORIZATION` fallback. Failed owner delivery does not forward secrets or task data to the global endpoint. Re-registration applies only to subsequent tasks.

Owner endpoints must use public HTTPS. Registration and delivery validate every resolved IP, blocking local/private, CGNAT, link-local, metadata, unspecified, multicast, and broadcast destinations, including IPv4-mapped IPv6. Delivery pins a validated address while retaining the original TLS hostname, preventing DNS rebinding; redirects fail. `COPILOT_AGENTS_NOTIFY_ALLOWED_HOSTS` optionally narrows allowed hostnames (comma-separated); it never permits blocked IPs. Unset means any public HTTPS host.

Owner and global POST bodies contain only `task_id`, `state`, `repo`, and `pr_url` (nullable), with a stable `Idempotency-Key: <task_id>:<status>` per task and terminal status. Receivers should deduplicate this key and call `get_agent_task` for details. Delivery records remain in local state; inspect `get_agent_task.delivery` and use scheduled checks if delivery fails.

Receiving the POST is not enough: your webhook handler must **wake the agent that owns the task live**. A silent or muted handler may still accept the completion payload but the owning agent is not notified, so completions are missed or surface only when someone checks later. Platform-specific delivery settings are in [Platform notes](#platform-notes) below.

If the receiver uses a private CA, set `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` before starting the server/watcher process that sends webhooks. Setting it only on the receiver does not configure the sender's trust.

### Platform notes

Add one `#### <Platform>` heading per host environment when webhook delivery must be configured in that platform's UI. Keep platform-neutral wording in MCP tool results and `setup` hints; put host-specific steps under the matching heading only.

#### Grok Bot

The webhook-triggered routine must deliver into the **owning bot's own chat** (`deliverTo = app_chat`). `deliverTo = none` accepts the POST but does **not** wake that bot, so task completions are missed or delayed.

### Example client: Grok Bot routine

1. Each bot creates its own webhook-trigger routine (see [Grok Bot](#grok-bot) platform notes for `deliverTo`).
2. The owner copies that routine's URL and complete Authorization value into the hidden prompts of `copilot-agents-mcp webhook register --owner <botName>`. Never paste either into chat.
3. Store its minted token privately and have that bot launch a tiny task using `owner_token`, such as a one-line documentation correction. Do not use shared connector environment variables as identity.
4. Verify end-to-end that its routine receives the terminal notice and calls `get_agent_task` once for the result. Confirm another bot's routine is not triggered. No release or merge is needed.

## Develop

```bash
bash scripts/setup
pnpm test
pnpm run typecheck
pnpm run lint
pnpm run build
```

See [AGENTS.md](AGENTS.md) for agent maintenance notes.

## License

[MIT](LICENSE)