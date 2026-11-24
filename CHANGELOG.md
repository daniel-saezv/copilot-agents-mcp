# Changelog

## 0.2.0

- Refine agent-facing descriptions, input documentation, annotations, and no-polling instructions without renaming tools or changing accepted inputs.
- Publish output schemas for all six tools, retaining structured results and compact JSON text.
- Distinguish upstream refusal statuses with actionable, secret-free hints, including repository/model policy guidance for task creation (#24).
- Distinguish webhook HTTPS, public-address, host allowlist, DNS, and input failures without exposing secrets.
- Preserve DNS-pinned HTTPS delivery, owner routing/global fallback, CLI-only hidden registration, private hashed key files, and presence-only authentication diagnostics.

## 0.1.0

- Add `list_agent_tasks` for scheduled checks with `owner`, `status`, and `all_terminal`.
- Add optional `owner` on `create_agent_task` (labeling convention, not security).
- Replace `notification` with `follow_up`; replace `notified` with `delivery`.
- Compact default JSON tool outputs; use `verbose` for full fields.
- `session_url` and `pr_url` on create (`follow_up.session_url`), `get_agent_task`, and `list_agent_tasks` (from API data, no extra calls).
- Unified task `status` vocabulary and one-line `summary`.
- Structured errors: `{"error":{"code","message","retryable",...}}`.
- Shared 60s freshness cache; terminal tasks are never re-fetched from GitHub.
- Registry retention: hide terminal tasks from list after 7 days; prune after 30 days.