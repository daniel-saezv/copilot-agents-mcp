# Authentication

`copilot-agents-mcp` version 0.0.1 requires Node.js 26 or later. It accepts one active credential in this order:

1. `GITHUB_PERSONAL_ACCESS_TOKEN`, when the value is non-empty.
2. A GitHub App session stored in the system keyring.
3. No credential. Tool calls that contact GitHub then return an authentication error.

The server ignores `GH_TOKEN` and `GITHUB_TOKEN`.

## Personal access token

Set `GITHUB_PERSONAL_ACCESS_TOKEN` in the server process environment. Do not pass the token through command arguments.

```json
{
  "mcpServers": {
    "copilot-agents": {
      "command": "npx",
      "args": ["-y", "github:daniel-saezv/copilot-agents-mcp"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "github_pat_..."
      }
    }
  }
}
```

When `GITHUB_PERSONAL_ACCESS_TOKEN` is set, the server does not read the keyring.

## GitHub App device flow

Install the default app for only the repositories where you use Copilot agent tasks:

<https://github.com/apps/copilot-agents-mcp/installations/new>

Then sign in:

```bash
npx -y github:daniel-saezv/copilot-agents-mcp login
```

Open the displayed URL and enter the displayed code. The device code expires after 15 minutes by default. Never enter a code that you did not request from that terminal.

The default client ID is `Iv23liNbsc3GH7vmP8OT`. The client ID is not a secret. To use another GitHub App, set `COPILOT_AGENTS_GITHUB_APP_CLIENT_ID` and enable its device flow:

```bash
COPILOT_AGENTS_GITHUB_APP_CLIENT_ID=Iv23... \
npx -y github:daniel-saezv/copilot-agents-mcp login
```

The access token expires after 8 hours, and the refresh token expires after 6 months. The server refreshes the access token 5 minutes before expiry and after a 401. A refresh rotates both tokens.

## Keyring storage

The session uses the `copilot-agents-mcp:github.com` keyring service and the operating system account name:

- macOS: Keychain.
- Windows: Credential Manager.
- Linux: Secret Service, such as gnome-keyring, KWallet, or KeePassXC.

On Linux, the server does not silently fall back from Secret Service. If the keyring is unavailable, `login` keeps the token in that process only. The token is lost when the process exits.

## Manage the session

Show the active method without printing token values:

```bash
npx -y github:daniel-saezv/copilot-agents-mcp auth status
```

Delete the local session:

```bash
npx -y github:daniel-saezv/copilot-agents-mcp logout
```

`logout` also prints the GitHub settings path for revoking app access. It does not uninstall the app from a repository or organization.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | PAT credential. Takes precedence over the keyring. |
| `COPILOT_AGENTS_GITHUB_APP_CLIENT_ID` | Alternate GitHub App client ID. |
| `GH_TOKEN` | Ignored. |
| `GITHUB_TOKEN` | Ignored. |
| `GITHUB_TOOLSETS` | Comma-separated toolsets to expose. |
| `GITHUB_TOOLS` | Comma-separated tools to expose. |
| `GITHUB_EXCLUDE_TOOLS` | Comma-separated tools to remove. |
| `GITHUB_READ_ONLY` | Set to `1` or `true` to expose only GET tools. |
| `COPILOT_AGENTS_NOTIFY_URL` | Optional notification POST URL. |
| `COPILOT_AGENTS_NOTIFY_AUTHORIZATION` | Optional `Authorization` value for the POST. |
| `COPILOT_AGENTS_STATE_PATH` | State file path. Defaults to `~/.copilot-agents-mcp/state.json`. |
| `COPILOT_AGENTS_POLL_INTERVAL_MS` | Watcher polling interval. Defaults to `15000`. |
| `COPILOT_AGENTS_LOG` | Optional watcher log path. |
