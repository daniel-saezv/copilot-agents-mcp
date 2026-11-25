# Notifications

Delivery is **at-least-once** bookkeeping in local state. `get_agent_task.delivery` (`not_configured` | `pending` | `delivered` | `failed`) does not wake your agent by itself.

Your webhook handler must wake the agent that owns the task live. A silent or muted handler can still receive the completion POST without notifying that agent, so completions are missed or arrive late. See [Platform notes](../README.md#platform-notes) in the README for host-specific delivery settings (no duplication here).

## Webhook

For optional per-client registration, use `copilot-agents-mcp webhook register --owner <id>` and the hidden prompts (or `--url-file` / `--auth-file`). See the [webhook security model and client example](../README.md#optional-per-client-webhooks). Owner delivery contains only `task_id`, `state`, `repo`, and `pr_url`, uses a stable `Idempotency-Key`, pins validated public HTTPS addresses, and rejects redirects.

For non-interactive migration or recovery, use `copilot-agents-mcp webhook register --owner <id> --url-file <f> --auth-file <f> --force-replace --token-out <path>`. `--force-replace` explicitly bypasses the current-token check for registration or removal without requiring a TTY. Registration still requires both private input files without a TTY; `--token-out` is recommended so the minted token goes only to a new mode `0600` file, never stdout. Without the override, replacement and removal require the current token via `--token-file` or a hidden prompt.

Only tasks created after their owner's registration use it. Otherwise the existing global webhook below is used. Without either configuration, scheduled checks remain the default.

Registration errors distinguish non-HTTPS URLs, non-public resolved addresses, hosts outside `COPILOT_AGENTS_NOTIFY_ALLOWED_HOSTS`, DNS failures, and invalid input. Correct the indicated setting and register again. Reasons never print the URL path/query or Authorization value. Delivery revalidates DNS and pins the connection to a validated public IP; these diagnostics do not relax that check.

Set `COPILOT_AGENTS_NOTIFY_URL` to the webhook endpoint (`https://…`). The background watcher POSTs JSON when a task reaches a terminal state (or when a steered turn completes). Like owner delivery, the global body contains exactly `task_id`, `state`, `repo`, and `pr_url` (nullable), with `Idempotency-Key: <task_id>:<status>` using the terminal status. Deduplicate this key and call `get_agent_task` for details; the full task and body `id` are no longer sent.

For a receiver using a private CA, set `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` before starting the server/watcher process that sends webhooks, not only on the receiver.

Set `COPILOT_AGENTS_NOTIFY_AUTHORIZATION` to the literal string `Bearer <key>`: `Bearer` exactly once, one space, then the routine’s Authorization key. This is sent verbatim as the HTTP `Authorization` header—not the webhook URL.

Without a webhook URL, `create_agent_task` returns `follow_up.mode: check_later` and scheduling text in `next_step`.

## Watcher

`create_agent_task` starts a detached watcher when an eligible owner webhook or global notify URL is configured. You can also run `copilot-agents-mcp watch`. Poll interval is fixed at 15 seconds. Delivery failures retain the existing `failed` record; no additional retry loop is introduced.

State files from pre-release builds that still have legacy `delivery: { status: "failed" }` and no `notified_at` may trigger one extra notification after you upgrade; there is no migration because that shape never shipped in a release.