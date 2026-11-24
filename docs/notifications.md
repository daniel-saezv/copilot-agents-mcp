# Notifications

Delivery is **at-least-once** bookkeeping in local state. `get_agent_task.delivery` (`not_configured` | `pending` | `delivered` | `failed`) does not wake your agent by itself.

## Webhook

Set `COPILOT_AGENTS_NOTIFY_URL` to the webhook endpoint (`https://…`). The background watcher POSTs JSON when a task reaches a terminal state (or when a steered turn completes).

Set `COPILOT_AGENTS_NOTIFY_AUTHORIZATION` to the literal string `Bearer <key>`: `Bearer` exactly once, one space, then the routine’s Authorization key. This is sent verbatim as the HTTP `Authorization` header—not the webhook URL.

Without a webhook URL, `create_agent_task` returns `follow_up.mode: check_later` and scheduling text in `next_step`.

## Watcher

`create_agent_task` starts a detached watcher when a notify URL is configured. You can also run `copilot-agents-mcp watch`. Poll interval is fixed at 15 seconds.

State files from pre-release builds that still have legacy `delivery: { status: "failed" }` and no `notified_at` may trigger one extra notification after you upgrade; there is no migration because that shape never shipped in a release.