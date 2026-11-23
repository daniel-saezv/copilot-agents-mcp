# Notifications

Completion notices **do not** come back over MCP. The detached watcher polls GitHub and, when a task reaches a final state, delivers JSON through a desktop toast (`notify-send`, `osascript`, or PowerShell) and/or an HTTP POST. MCP clients must not poll `get_agent_task` in a loop waiting for that signal.

To wake an autonomous agent, set `COPILOT_AGENTS_NOTIFY_URL` to an inbound webhook on the host that runs the agent (for example a small HTTP handler that posts a follow-up message into the agent session).

The watcher starts after `create_agent_task` and after an accepted steer. You can also run it directly:

```bash
npx -y copilot-agents-mcp watch
```

The watcher polls until a task reaches `completed`, `failed`, `timed_out`, `cancelled`, or `idle`. It notifies once for each turn and resumes unfinished tasks from local state.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `COPILOT_AGENTS_STATE_PATH` | `~/.copilot-agents-mcp/state.json` | Local task state. |
| `COPILOT_AGENTS_POLL_INTERVAL_MS` | `15000` | Delay between watcher reads. |
| `COPILOT_AGENTS_LOG` | Unset | Error log path. Without it, errors go to stderr. |
| `COPILOT_AGENTS_NOTIFY_URL` | Unset | URL for a JSON POST. |
| `COPILOT_AGENTS_NOTIFY_AUTHORIZATION` | Unset | `Authorization` header value for the POST. |

## System notification

The watcher uses PowerShell on Windows, `osascript` on macOS, and `notify-send` on Linux. It never exposes the GitHub token to the spawned notification process.

If the system notifier cannot start or exits with an error, the watcher logs the failure and still tries a configured POST. If **no** channel succeeds, the task is marked with `delivery.status: "failed"` in local state, `notified_at` stays unset, and `get_agent_task` returns `notified: false`. The watcher does not retry forever.

## Notification POST

The request sends `Content-Type: application/json`. It adds `Authorization` only when `COPILOT_AGENTS_NOTIFY_AUTHORIZATION` is set.

```json
{
  "task_id": "0ad0914d-889f-4221-bdae-42074c1ab62e",
  "repo": "octocat/hello-world",
  "state": "completed",
  "requested_model": "grok-4.7",
  "resolved_model": "sweagent-capi:grok-4.7",
  "pull_request": {
    "id": 42,
    "number": 7,
    "html_url": "https://github.com/octocat/hello-world/pull/7"
  },
  "branch": {
    "head_ref": "copilot/demo",
    "base_ref": "main"
  },
  "artifacts": [
    { "type": "pull", "id": 42 },
    {
      "type": "branch",
      "head_ref": "copilot/demo",
      "base_ref": "main"
    }
  ],
  "error": null,
  "usage": {
    "type": "ai_credits",
    "amount": 344355000,
    "amount_human": 0.344355
  },
  "created_at": "2026-11-22T00:00:00Z",
  "updated_at": "2026-11-22T00:01:00Z",
  "completed_at": "2026-11-22T00:05:00Z",
  "session_id": "session-1"
}
```

`resolved_model` is the latest `sessions[].model`, or `null`. `usage.amount_human` divides `ai_credits` by `1e9`; it leaves `premium_requests` unchanged.

`session_id` is the latest task session ID. `get_agent_task` and notifications return the same value.

## Repeat a notification

To send a final task notification again, stop the watcher, back up the state file, set that task's `notified_at` to `null`, and start `watch` against the copied state.

The watcher does not refetch the task for this case. It recalculates usage and resolves missing pull request fields.
