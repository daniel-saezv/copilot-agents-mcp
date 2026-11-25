# Changelog

## 0.3.0

### Breaking

- `create_agent_task` replaces the free-text `owner` argument with `owner_token`. Owned tasks also require that token on `steer_agent_task` and `abort_agent_task`; `set_completion_strategy` accepts the same token. `list_agent_tasks.owner` remains a shared, case-insensitive label filter, not identity.
- Owner webhook registrations now require a server-minted token. Existing 0.2.0 registrations need re-registration and no longer enable owner delivery. Replacing or removing a registration requires its current token or a local TTY-only `--force-replace` override.

### Migration from 0.2.0

1. Run `copilot-agents-mcp webhook register --owner <label> --force-replace --token-out /private/path/owner-token` in a terminal for each existing owner. Enter the webhook URL and Authorization value through the hidden prompts; never paste them in chat.
2. Store the minted token privately. `--token-out` creates a new mode `0600` file and refuses to overwrite an existing path; without it, the CLI shows the token once on stdout. Only its SHA-256 hash is stored in state.
3. Replace `owner` with `owner_token` on `create_agent_task`. Pass the same token on `steer_agent_task`, `abort_agent_task`, and `set_completion_strategy`; continue using the label only as a `list_agent_tasks.owner` filter. No environment variable supplies owner identity.
4. To rotate, re-run registration with `--token-file /private/path/current-token` and a new `--token-out` path. Update the agent's private token. Removal likewise needs `--token-file` or a hidden prompt; reserve `--force-replace` for local recovery.

### Added

- A once-per-owner `setup` result on creation or listing asks how the user wants completion follow-up. Clients ask in the user's current language and record `webhook` or `check_later` with `set_completion_strategy`. The hint does not block creation and works without elicitation or server instructions.
- Completion preferences and the one-time ask timestamp persist under the state lock. Unowned calls use `_default`; until a channel is configured, follow-up remains scheduled checks.
- `webhook list` and `auth status` flag legacy registrations without exposing credentials.
- Removal retains a hash-only label reservation to prevent takeover of existing tasks. Owned creation, steering, and cancellation serialize authorization and mutation against token rotation.

### Preserved

- Global notification fallback for unowned tasks, minimal webhook bodies and Idempotency-Key, private Authorization files, DNS-pinned public HTTPS delivery, `NODE_EXTRA_CA_CERTS`, and keyring/GitHub authentication.

### Internal

- Migrate development tooling and automation from npm to pnpm.
- Package smoke uses pnpm and verifies the seven-tool surface and intended package contents.

## 0.2.0

- **Breaking** for global-webhook receivers (`COPILOT_AGENTS_NOTIFY_URL`): the body now contains only `task_id`, `state`, `repo`, and `pr_url`, not the full task. Call `get_agent_task` for details. The `Idempotency-Key` header is now sent.
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