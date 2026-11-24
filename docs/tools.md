# Tool reference

The server exposes six tools over stdio. See README for setup. MCP **instructions** at initialize describe runtime usage (no polling, `check_after`, webhook vs `check_later`).

## `create_agent_task`

Launch a Copilot cloud agent task. Returns immediately with `task_id`, `follow_up`, and `next_step`. Pass `owner` when several agents share one server.

## `get_agent_task`

Read one task once. Use `list_agent_tasks` for scheduled checks.

## `list_agent_tasks`

Check all tracked tasks in one call. Stop when `all_terminal` is true.

## `steer_agent_task`

Experimental: send a user message to a task with an open pull request.

## `abort_agent_task`

Experimental: request cancellation via the internal steer endpoint.

## `list_copilot_models`

Read `/agents/swe/models` with billing fields validated client-side.