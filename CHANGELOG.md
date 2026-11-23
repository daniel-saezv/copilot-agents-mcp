# Changelog

## 0.1.0

- Add `list_agent_tasks` for scheduled checks with `owner`, `status`, and `all_terminal`.
- Add optional `owner` on `create_agent_task` (labeling convention, not security).
- Replace `notification` with `follow_up`; replace `notified` with `delivery`.
- Compact default JSON tool outputs; use `verbose` for full fields.
- Unified task `status` vocabulary and one-line `summary`.
- Structured errors: `{"error":{"code","message","retryable",...}}`.
- Shared 60s freshness cache; terminal tasks are never re-fetched from GitHub.
- Registry retention: hide terminal tasks from list after 7 days; prune after 30 days.