# Authentication

Prefer GitHub App login:

```bash
npx -y github:daniel-saezv/copilot-agents-mcp login
npx -y github:daniel-saezv/copilot-agents-mcp auth status
```

`auth status` prints the active credential (never tokens) and local diagnostics without network calls: state path and lock-dir writability, notify env vars set yes/no (never their values), and `DBUS_SESSION_BUS_ADDRESS` on Linux.

Alternatively set `GITHUB_PERSONAL_ACCESS_TOKEN` in the MCP server environment. `GH_TOKEN` and `GITHUB_TOKEN` are ignored.

Optional: `COPILOT_AGENTS_GITHUB_APP_CLIENT_ID`, `COPILOT_AGENTS_GITHUB_API_BASE_URL` for Enterprise or test fakes.