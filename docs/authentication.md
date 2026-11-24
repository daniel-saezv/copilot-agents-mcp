# Authentication

Prefer GitHub App login:

```bash
npx -y github:daniel-saezv/copilot-agents-mcp login
npx -y github:daniel-saezv/copilot-agents-mcp auth status
```

`auth status` prints the active credential (never tokens) and local diagnostics without network calls. Only a non-writable state file or lock directory fails the command (exit code 1). Webhook notify vars are optional (`Info: webhook: not configured` when both unset); if exactly one of `COPILOT_AGENTS_NOTIFY_URL` / `COPILOT_AGENTS_NOTIFY_AUTHORIZATION` is set, a warning is shown. Presence is checked without reading values (yes/no only). `DBUS_SESSION_BUS_ADDRESS` is reported yes/no with an info line on Linux when unset.

Alternatively set `GITHUB_PERSONAL_ACCESS_TOKEN` in the MCP server environment. `GH_TOKEN` and `GITHUB_TOKEN` are ignored.

Optional: `COPILOT_AGENTS_GITHUB_APP_CLIENT_ID`, `COPILOT_AGENTS_GITHUB_API_BASE_URL` for Enterprise or test fakes.