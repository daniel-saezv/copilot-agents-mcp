# Tool reference

The server exposes six tools over stdio. See README for setup. MCP **instructions** at initialize describe runtime usage (no polling, `check_after`, webhook vs `check_later`).

## Contract and compatibility

Version 0.2.0 keeps all 0.1.0 tool names and accepted inputs. Descriptions document existing constraints and defaults rather than imposing new UUID formats, model allowlists, or string length limits. Unknown input properties remain rejected.

Every successful call returns an object matching its advertised `outputSchema`, both as `structuredContent` and as compact JSON in `content[0].text`. Existing text consumers can keep parsing the same JSON; there is no new wrapper or format parameter. Absent/null values remain omitted. Errors use `isError: true` and JSON text, without success `structuredContent`.

All tools set `openWorldHint: true` because they access GitHub. `get_agent_task`, `list_agent_tasks`, and `list_copilot_models` are read-only and idempotent hints (task reads can update the local cache). Creation and steering are non-idempotent, non-destructive operations; only cancellation is destructive and idempotent. Hints do not authorize actions.

## `create_agent_task`

Launch a Copilot cloud agent task. Returns immediately with `task_id`, `follow_up`, and `next_step`. Pass `owner` when several agents share one server.

Required: `repo` (`owner/name`), non-blank `prompt`, and non-blank `model`. Optional: `base_ref`, `head_ref`, `custom_agent`, `create_pull_request`, and `owner` (1–64 characters matching `[A-Za-z0-9._-]+`). Model IDs remain open-ended; use `list_copilot_models` for discovery, not a guarantee of repository policy access. Omitted GitHub options retain GitHub defaults.

```json
{"repo":"octocat/hello-world","prompt":"Add a regression test for the parser","model":"gpt-6.1-sol","owner":"review-bot"}
```

The result includes `status`, `terminal`, `requested_model`, `delivery`, and available PR/session links. Webhooks are **RECOMMENDED**: configure them using the local `webhook register` CLI, never through an MCP tool. End the turn after creation. For `follow_up.mode: "check_later"`, schedule `list_agent_tasks` at `follow_up.check_after`, space subsequent checks by `follow_up.min_interval_s`, and never loop.

## `get_agent_task`

Read one task once. Use `list_agent_tasks` for scheduled checks.

Required: `task_id`. Optional: `repo` (otherwise saved repository or user endpoint) and `verbose` (default false). Returns `task_id`, `repo`, `status`, `terminal`, `summary`, `delivery`, and available links. Verbose adds raw state, models, artifacts, branch, usage, session/timestamps, and error (up to 2048 characters). A resolved verbose `pull_request` uses `number` and optional `url`; an unresolved one uses `id`.

```json
{"task_id":"task-id-from-create","verbose":true}
```

Refresh failures can return saved data with `stale` and `warnings`. Without credentials, only terminal cached results are available.

## `list_agent_tasks`

Check all tracked tasks in one call. Stop when `all_terminal` is true.

Optional: `owner`, up to 50 `task_ids`, `status` (`pending`, `terminal`, or default `all`), exact `repo`, `limit` (1–50, default 20), and compatibility flag `verbose` (rows stay compact). Omitted/empty `task_ids` selects all tracked IDs. Owner filtering is case-insensitive; webhook owner routing remains exact and case-sensitive. Owner is a label, not authentication.

```json
{"owner":"review-bot","status":"pending","limit":50}
```

Returns `tasks`, `pending_count`, `terminal_count`, `all_terminal`, `next_step`, optional `next_check_after`, and warnings/staleness. Counts cover every matching task, even beyond `limit`; this is not a paginated GitHub-wide search. Terminal tasks are visible for seven days and pruned after thirty days. Use `task_ids` or `get_agent_task` for specific known tasks. Pending tasks require credentials; terminal-only local results can be returned stale without credentials.

## `steer_agent_task`

Experimental: send a user message to a task with an open pull request.

Required: non-blank `task_id` and `content`. Returns `task_id`, `accepted`, and pre-steer `session_count`. Every call consumes credits and may send another instruction; do not retry blindly. The agent applies the instruction after its current tool call. An accepted steer arms the watcher for the next turn when notifications are configured. Missing repository/PR or a closed PR prevents steering.

## `abort_agent_task`

Experimental: request cancellation via the internal steer endpoint.

Required: non-blank `task_id`. Returns `task_id`, `accepted`, and optional `status`, `terminal`, and `reason`. Already-finished tasks return `accepted: false` with `reason: "already finished"`. Acceptance is a cancellation request, not proof it has finished. The internal endpoint has not been verified against live GitHub.

## `list_copilot_models`

Read `/agents/swe/models` with billing fields validated client-side.

No arguments (`{}`). Returns `source` (`url`, `fetched_at`) and `models` with `id`, `name`, `vendor`, `preview`, billing token prices or multiplier, and optional promotion/policy. Repository policy may still reject a listed model.

## Errors

```json
{"error":{"code":"forbidden","message":"Permission denied. Check repository access and Copilot policy.","retryable":false}}
```

Upstream HTTP status, not arbitrary response text, determines API refusal codes. Existing `forbidden` is retained rather than renamed to `permission_denied`.

| Code | Meaning / next action |
| --- | --- |
| `invalid_argument` | Invalid local input or upstream 400/422. Check repository, refs, prompt, and model before retrying. |
| `not_authenticated` | Missing session or upstream 401. Run `copilot-agents-mcp login` in the same session or configure `GITHUB_PERSONAL_ACCESS_TOKEN`. |
| `forbidden` | Upstream 403. Check repository permissions; on creation, Copilot coding agent may not be enabled or the model may not be allowed. |
| `not_found` | Upstream 404. Verify task/repository identifiers and access, including app installation. |
| `conflict` | Upstream 409. Refresh task state and resolve the conflict before retrying. |
| `rate_limited` | Upstream 429 or an explicit GitHub rate-limit refusal. Wait for `retry_after_s` when provided. |
| `upstream_timeout` | Request timeout or upstream 408/504. Check connectivity and retry later; verify a state-changing request was not already accepted. |
| `upstream_error` | Other upstream/network/response failure. Check service availability before retrying; do not blindly repeat creation or steering. |
| `model_unavailable` | Previously rejected model. Choose another model from accepted observations or discovery. |

`retryable` describes the failure, not permission to repeat a non-idempotent operation. `retry_after_s` is optional. Refusal hints never include raw response bodies, credentials, Authorization values, or secret URL paths/queries.