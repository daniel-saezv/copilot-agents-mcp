# Tool reference

`copilot-agents-mcp` publishes six tools. The default toolsets are `copilot_tasks` and `copilot_models`.

All schemas reject additional properties. GET tools are read-only. POST tools are not marked idempotent.

The MCP server also publishes **instructions** at initialize time: cloud tasks take minutes, `create_agent_task` returns immediately, clients must not poll in a loop, and completion arrives outside MCP through the notification channels listed in the create response (or a user follow-up).

## `create_agent_task`

Launch a GitHub Copilot cloud agent task. Returns immediately; do not poll in a loop—end the turn and wait for the completion notice (sent via `notification.channels`) or a user prompt before calling `get_agent_task`.

Input:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `repo` | string | yes | Repository in `owner/name` form. |
| `prompt` | string | yes | Instructions for the agent. |
| `model` | string | yes | Model sent unchanged to the API. |
| `base_ref` | string | no | Base branch for a new branch or pull request. |
| `head_ref` | string | no | Existing branch. With `base_ref`, the agent commits to this branch. |
| `custom_agent` | string | no | Custom agent name without the extension. |
| `create_pull_request` | boolean | no | When true, the API creates a pull request. |

Output (compact): `task_id`, `repo`, `status`, `terminal`, `requested_model`, optional `owner`, optional `session_url` (Copilot agent session page from the create response), `follow_up` (`mode`, `check_after`, `min_interval_s`, `check_with`, optional `channels`, optional `session_url`), and `next_step`.

The server blocks a model already recorded as rejected and lists accepted models observed so far.

## `get_agent_task`

Read one task once. Returns `status`, `terminal`, a one-line `summary`, and `delivery`. Use `list_agent_tasks` for periodic checks.

Input: `task_id` (required), `repo` (optional), `verbose` (optional).

Compact output includes `session_url` and `pr_url` when known (from data already returned by the GitHub API—no extra calls). Optional URL hints may appear at the end of `summary` when the line stays within 160 characters. With `verbose: true`, outputs also include raw `state`, models, `pull_request`, `branch`, `usage`, and related fields.

## `list_agent_tasks`

One call to check all tasks launched through this server. Each task row includes `session_url` and `pr_url` when known, plus `status`, `terminal`, and `summary`. When `all_terminal` is `true`, stop scheduled checks.

## `steer_agent_task`

Send an instruction to a task with an open pull request.

> [!WARNING]
> This tool uses an undocumented internal GitHub endpoint. It can change without notice. Each steer consumes credits.

Input:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `task_id` | string | yes | Task identifier. |
| `content` | string | yes | Instruction for the agent. |

Output: `{ task_id, accepted: true, session_count }`.

The agent applies the instruction after its current tool call finishes. An accepted steer arms the watcher for a new turn.

## `abort_agent_task`

Stop a task through GitHub's internal steer endpoint.

> [!WARNING]
> This endpoint is undocumented and this call has not been verified against GitHub.

Input: required string `task_id`.

Output: `{ task_id, accepted: true }`.

## `get_agent_task_events`

Read a page of task events through an internal read-only endpoint.

Input:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `task_id` | string | yes | Task identifier. |
| `page` | positive integer | yes | Page starting at 1. |
| `per_page` | positive integer | yes | Events per page. |

Output:

- `task_id`: string.
- `page`: number.
- `per_page`: number.
- `total`: number.
- `events`: array of `{ id, timestamp, parentId, type, data }`. The first four fields are strings or null; `data` can contain any value.

## `list_copilot_models`

Read `/agents/swe/models`.

Input: an empty object.

Output:

- `source.url`: URL fetched.
- `source.fetched_at`: ISO timestamp.
- `models[]`: array of objects with:
  - `id`, `name`, `vendor`: strings.
  - `preview`: boolean.
  - `policy.state`: string or null.
  - `billing.token_prices`: optional `{ input_price, output_price, cache_price, batch_size }`.
  - `billing.multiplier`: optional number.
  - `billing.promo`: optional `{ discount_percent, ends_at, message }`.

`token_prices` is required unless the model has `billing.multiplier`.

## Selection

Use CLI flags or environment variables:

```bash
npx -y copilot-agents-mcp \
  --toolsets copilot_tasks,copilot_models \
  --read-only
```

The equivalent environment variables are `GITHUB_TOOLSETS`, `GITHUB_TOOLS`, `GITHUB_EXCLUDE_TOOLS`, and `GITHUB_READ_ONLY`.

`copilot_automations` and `copilot_agent_merge` require the `agent_automations` and `agent_merge` features. They currently publish no tools.
