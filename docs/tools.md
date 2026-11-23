# Tool reference

`copilot-agents-mcp` version 0.0.1 publishes six tools. The default toolsets are `copilot_tasks` and `copilot_models`.

All schemas reject additional properties. GET tools are read-only. POST tools are not marked idempotent.

## `create_agent_task`

Launch a GitHub Copilot cloud agent task.

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

Output: `task_id`, `repo`, `state`, `requested_model`, nullable `created_at`, and nullable `html_url`.

The server blocks a model already recorded as rejected and lists accepted models observed so far.

## `get_agent_task`

Read a task once and update local state.

Input:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `task_id` | string | yes | Task identifier. |
| `repo` | string | no | Repository in `owner/name` form. If omitted, use the saved repository or user endpoint. |

Output fields:

| Field | Type | Description |
| --- | --- | --- |
| `task_id` | string | Task identifier. |
| `repo` | string | Repository name. |
| `state` | string | Current task state. |
| `requested_model` | string or null | Model originally requested. |
| `resolved_model` | string or null | Latest `sessions[].model`. |
| `pull_request` | object or null | `{ id, number, html_url }`. `id` is internal to the API. |
| `branch` | object or null | `{ head_ref, base_ref }`. |
| `artifacts` | array | Pull and branch artifacts. |
| `error` | string or null | Failure text. |
| `usage` | object or null | `{ type, amount, amount_human }`. |
| `created_at` | string or null | Creation time. |
| `updated_at` | string or null | Update time. |
| `completed_at` | string or null | Completion time. |
| `session_id` | string or null | Latest session ID. |

For `ai_credits`, `amount_human` is `amount / 1e9`. For `premium_requests`, it equals `amount`.

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
