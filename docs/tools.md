# Tool reference

The server exposes seven tools over stdio. See README for setup. Tool descriptions and results carry completion setup guidance even when clients ignore MCP **instructions**.

## Contract and compatibility

Version 0.3.0 replaces `create_agent_task.owner` with `owner_token` and uses it on `create_agent_task`, `steer_agent_task`, `abort_agent_task`, and `set_completion_strategy`; owned tasks require their matching token to steer or abort. `list_agent_tasks.owner` remains a shared label filter, not identity. Unknown input properties remain rejected. See [migration](../CHANGELOG.md#migration-from-020).

Version 0.3.1 removes only the TTY requirement on the local CLI's explicit `--force-replace` override; tool token authorization is unchanged. For non-interactive migration, use `copilot-agents-mcp webhook register --owner <id> --url-file <f> --auth-file <f> --force-replace --token-out <path>`. Both private input files are required without a TTY; `--token-out` is recommended to write the token only to a new mode `0600` file, never stdout.

Every successful call returns an object matching its advertised `outputSchema`, both as `structuredContent` and as compact JSON in `content[0].text`. Existing text consumers can keep parsing the same JSON; there is no new wrapper or format parameter. Absent/null values remain omitted. Errors use `isError: true` and JSON text, without success `structuredContent`.

GitHub tools set `openWorldHint: true`. `get_agent_task`, `list_agent_tasks`, and `list_copilot_models` are read-only and idempotent hints (task reads can update the local cache and the one-time setup timestamp). Creation and steering are non-idempotent, non-destructive operations; cancellation is destructive and idempotent. `set_completion_strategy` only changes local preferences. Hints do not authorize actions.

## `create_agent_task`

Launch a Copilot cloud agent task. Returns immediately with `task_id`, `follow_up`, and `next_step`. Pass the locally minted `owner_token` for owner-specific routing; no token creates an unowned task.

Required: `repo` (`owner/name`), non-blank `prompt`, and non-blank `model`. Optional: `base_ref`, `head_ref`, `custom_agent`, `create_pull_request`, and `owner_token`. Model IDs remain open-ended; use `list_copilot_models` for discovery, not a guarantee of repository policy access. Omitted GitHub options retain GitHub defaults. An invalid token fails before task creation, without notification fallback.

```json
{"repo":"octocat/hello-world","prompt":"Add a regression test for the parser","model":"gpt-6.1-sol","owner_token":"<privately stored CLI token>"}
```

The result includes `status`, `terminal`, `requested_model`, `delivery`, and available PR/session links. Webhooks are **RECOMMENDED**: configure them using the local `webhook register` CLI, never through an MCP tool. The webhook handler must wake the agent that owns the task live; a silent or muted handler misses completions or delivers them late. End the turn after creation. For `follow_up.mode: "check_later"`, schedule `list_agent_tasks` at `follow_up.check_after`, space subsequent checks by `follow_up.min_interval_s`, and never loop.

### First-run `setup`

Creation and listing may also return a non-error `setup` object, in both JSON text and `structuredContent`. It appears once for an owner without a registered webhook or recorded strategy, with `_default` used for unowned calls. The server atomically records `asked_at` so concurrent or later calls do not repeat it. Creation never waits for an answer.

`setup.status` is `required`; `question_intent` and each option `intent` give the canonical English meaning for the user-facing question (webhook wakes the agent automatically after one-time local CLI setup, or check_later with scheduled checks). `options` have stable IDs `webhook` (recommended) and `check_later`, and `record_with` is `set_completion_strategy`. Follow `ask_instruction`: ask in the user's current language without changing the meaning, then record the answer. Separately, after the user chooses webhook, the webhook receiver must wake the agent that owns the task live (silent handlers miss completions or deliver them late; see Platform notes in the README)—that requirement is in `next_step` and tool docs, not in `question_intent`. Scheduled checks need no webhook setup (first about ten minutes after creation, then at most every five minutes). The choice is remembered. The server uses this hint rather than form elicitation, so auto-declining clients still receive it.

## `set_completion_strategy`

Record the user's answer locally. Required: `strategy` (`webhook` or `check_later`). Optional: `owner_token`; omission records `_default`. A supplied token must resolve to a current registration. The result includes the recorded strategy and a `next_step`. `webhook` points to `copilot-agents-mcp webhook register`, with hidden local input and no URL argument; choosing it alone does not configure delivery. The webhook receiver must wake the agent that owns the task live; silent handlers miss completions or deliver them late (see Platform notes in the README). `check_later` needs no local webhook setup. Neither result echoes the token.

For an authenticated owner, `check_later` suppresses notifications even when its webhook is registered; choosing `webhook` restores eligible delivery. Unowned tasks retain the existing global environment fallback independently of `_default` preferences.

```json
{"strategy":"check_later"}
```

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

Returns `tasks`, `pending_count`, `terminal_count`, `all_terminal`, `next_step`, optional `next_check_after`, `setup`, and warnings/staleness. Counts cover every matching task, even beyond `limit`; this is not a paginated GitHub-wide search. Terminal tasks are visible for seven days and pruned after thirty days. Use `task_ids` or `get_agent_task` for specific known tasks. Pending tasks require credentials; terminal-only local results can be returned stale without credentials.

## `steer_agent_task`

Experimental: send a user message to a task with an open pull request.

Required: non-blank `task_id` and `content`. Optional: `owner_token`, required for an owned task and checked before GitHub mutation or watcher re-arming. Returns `task_id`, `accepted`, and pre-steer `session_count`. Every call consumes credits and may send another instruction; do not retry blindly. The agent applies the instruction after its current tool call. An accepted steer arms the watcher for the next turn when notifications are configured. Missing repository/PR or a closed PR prevents steering.

## `abort_agent_task`

Experimental: request cancellation via the internal steer endpoint.

Required: non-blank `task_id`. Optional: `owner_token`, required for an owned task, including already-finished tasks. The server verifies the same token hash as steering and revalidates under the state lock before cancellation or cache changes. A wrong, missing, or mismatched token returns `owner_token_invalid` without an upstream abort request or state change; tokens are never echoed. Unowned tasks need no token.

Returns `task_id`, `accepted`, and optional `status`, `terminal`, and `reason`. Already-finished tasks return `accepted: false` with `reason: "already finished"`. Acceptance is a cancellation request, not proof it has finished. The internal endpoint has not been verified against live GitHub.

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
| `owner_token_invalid` | Invalid, rotated, missing for owned steering/cancellation, or mismatched owner token. Use the current privately stored CLI token; rejection leaves the task untouched and does not invoke upstream steering/cancellation. |
| `not_authenticated` | Missing session or upstream 401. Run `copilot-agents-mcp login` in the same session or configure `GITHUB_PERSONAL_ACCESS_TOKEN`. |
| `forbidden` | Upstream 403. Check repository permissions; on creation, Copilot coding agent may not be enabled or the model may not be allowed. |
| `not_found` | Upstream 404. Verify task/repository identifiers and access, including app installation. |
| `conflict` | Upstream 409. Refresh task state and resolve the conflict before retrying. |
| `rate_limited` | Upstream 429 or an explicit GitHub rate-limit refusal. Wait for `retry_after_s` when provided. |
| `upstream_timeout` | Request timeout or upstream 408/504. Check connectivity and retry later; verify a state-changing request was not already accepted. |
| `upstream_error` | Other upstream/network/response failure. Check service availability before retrying; do not blindly repeat creation or steering. |
| `model_unavailable` | Previously rejected model. Choose another model from accepted observations or discovery. |

`retryable` describes the failure, not permission to repeat a non-idempotent operation. `retry_after_s` is optional. Refusal hints never include raw response bodies, credentials, Authorization values, or secret URL paths/queries.