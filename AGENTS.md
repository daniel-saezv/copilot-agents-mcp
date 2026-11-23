# AGENTS.md

## Rules

1. Verify against the real artifact (run the feature, read the actual value, inspect the diff), not a proxy, self-report, or "it compiles."
2. Trace each symptom back to the first place the system went wrong and fix it there. A guard is a fix only when the state it handles is legitimate.
3. Remove dead code, redundant validators, and stub references first, then build on the simpler base.
4. Bias toward deletion and the smallest change that solves the problem.
5. Assert what the code's users can observe, so the test fails when that behavior breaks and keeps passing when only the internals change.
6. Keep a test that catches the first edit and survives the second. Rewrite or delete the rest.
7. Rename, extract, type, or rearchitecture so the behavior is obvious without prose.
8. Concentrate guards at system boundaries (CLI, config, network, external APIs). Trust internal types and keep business logic in pure functions.
9. Design every state-changing operation to converge to the correct state however many times it runs and wherever the previous run stopped.
10. Break work into small units that each end in a verifiable state, check each before the next, and order delivery so the sequence proves itself. Each commit lands on its own.
11. Before you trust, report, or act on a measured number, find what limits it, and rule out that it measured something other than the work you think.
12. Encode a repeated correction as a lint, metadata flag, runtime check, or script instead of more text.
13. Write the real symbol, file, flag, or command name, not a synonym or a description of it, and make every count or tree claim true at the commit that lands it.
14. A PR body is a briefing a reviewer can read in under a minute. Do not paste swarm logs, SHA lists, or metric tables. Link them.
15. Cut every word that does no work in documentation, PR descriptions, and commit messages.
16. Product direction comes from the human. Proceed on reversible work and present the result. Confirm only irreversible actions.
17. Environment setup lives in `scripts/setup` and is idempotent. Each cloud agent provider wrapper only calls that script. When dependencies, the toolchain, or startup steps change, update the script and check that the wrappers still work. If the project uses a provider that has no wrapper, add one.

## Skills

This template ships `project-setup` and `agent-environment` in `.agents/skills/`. `.claude/skills/` links to those folders so Claude Code loads the same skills.

## Credit

Rules 1 to 16 are adapted from [pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan, under the MIT license.

## This project

Local MCP server to launch GitHub Copilot cloud agents, read task status, notify on completion, and list Copilot models. There is no cloud deployment or hosted service: run it locally with `npx -y copilot-agents-mcp`.

### Stack

Node.js 26.13.1 (the package requires `>=26`) and npm 11.20.0. In development, Node runs `src/cli.ts` with type stripping. Node does not strip types inside `node_modules`, so `prepare` compiles to `dist/` with `tsc -p tsconfig.build.json` and the npm bin is `dist/cli.js`. Production dependencies: `@modelcontextprotocol/sdk` 1.32.2, `@napi-rs/keyring` 2.1.2, `zod` 4.6.7, `ajv` 8.20.0, and `ajv-formats` 3.0.1. Tests with Vitest 5.1.1. Lint with ESLint 10.15.0 and `typescript-eslint` 8.73.0. Types with TypeScript 6.0.3 (`tsc --noEmit`). `@types/node` 26.6.6.

### Structure

- `src/cli.ts` starts stdio, HTTP, `watch`, `login`, `logout`, and `auth status`.
- `src/server.ts` registers tools. `src/http.ts` listens on `127.0.0.1`. `src/selection.ts` applies toolsets and `X-MCP-*` headers.
- `src/github.ts` calls the agent tasks API with `X-GitHub-Api-Version: 2026-03-10` and validates responses against the official OpenAPI. `steerTask`, `abortTask`, and `getTaskEvents` use `https://api.github.com/cmc_internal/api/agents`, with `Accept: application/json` and without that header. A 401 with a GitHub App session refreshes the token and retries once. A 403 for permissions states which permission is missing.
- `src/auth.ts` runs device flow, stores the session in the keyring, and refreshes the access token. `src/keyring.ts` opens `@napi-rs/keyring` with service `copilot-agents-mcp:github.com` and, on Linux, the `secret-service` backend.
- `src/swe-models.ts` validates and reads `GET /agents/swe/models`. The base URL comes from GraphQL and is not hard-coded. `policy` and `policy.state` are optional in tool output when upstream omits them. `token_prices` is required unless the model includes `billing.multiplier`.
- `src/state.ts`, `src/watch.ts`, and `src/notify.ts` keep local state and notify once per turn. After an accepted steer they store `session_count` and the timestamp, restart the watcher, and the notification includes `session_id`.
- `fixtures/` holds OpenAPI examples. `src/__toolsnaps__/` pins `tools/list`.

### Verified commands

```bash
bash scripts/setup
npm test
npm run typecheck
npm run lint
npm run licenses
npm audit --audit-level=low
npm run build
node src/cli.ts
node dist/cli.js --help
node src/cli.ts --http --port 3333
```

`bash scripts/setup` was run twice in a row on Node.js 26.13.1 and exited 0 both times. It runs `npm ci`, and `prepare` compiles `dist/`. An earlier test pass left 24 tests in 5 files. After experimental redirect, `npm test` left 45 tests in 5 files. With a GitHub App session the count rose; on Node.js 26.13.1, `npm test` leaves 75 tests in 7 files. `npm run typecheck` and `npm run lint` exited 0. `npm run licenses` accepted 94 production packages. `npm audit --audit-level=low` found 0 vulnerabilities. `npm run build` exited 0, `node dist/cli.js --help` printed help, and `node src/cli.ts --version` printed `0.0.1`. `node scripts/pack-smoke.mjs` printed `--version 0.0.1` and the 6 tools from `tools/list`.

### Stack-specific practices

Relative imports use the `.ts` extension. Each tool schema sets `additionalProperties: false`. GitHub responses are validated client-side before use. The PAT is supplied via `GITHUB_PERSONAL_ACCESS_TOKEN`. The GitHub App session lives in the keyring, not in files. `GH_TOKEN` and `GITHUB_TOKEN` are not read. `npm audit --audit-level=low` and the license check are part of CI. Zod 4.6.7 and Vitest 5.1.1 are pinned in this range because earlier versions carried `npm audit` warnings.

### CI/CD

Workflows run on each pull request and each push to `main`:

- `.github/workflows/ci.yml`: Node 26. `npm ci`, types, lint, tests, `npm audit --audit-level=low`, licenses, and CodeQL (`javascript-typescript`). Actions are pinned by SHA.
- `.github/workflows/skills.yml`: validates `project-setup` and `agent-environment` with `skills-ref`. Node 26.
- `.github/workflows/copilot-setup-steps.yml`: installs Node 26 and runs `bash scripts/setup` when that script or the workflow changes.
- `.github/workflows/release.yml`: on `v*` tags, checks tag vs `package.json` version, runs `node scripts/pack-smoke.mjs` in `verify`, then stages the package on npm with `npm stage publish --provenance --access public` via OIDC (no tokens). The maintainer (Gamusino) approves the staged version on [npmjs.com](https://www.npmjs.com/) with 2FA before it goes live.

The branch protection API returned 403, so required checks are not recorded here. The workflows above run on each PR. Consider requiring the `test` and `codeql` jobs from `ci.yml` before merge if they are not already required. The project is not deployed. npm releases use staged publishing (see `release.yml`). Distribution is `npx -y copilot-agents-mcp` from the npm registry.

## Cursor Cloud specific instructions

`.cursor/environment.json` only calls `bash scripts/setup`. There is no `start`: the default server stays on stdio.

To test: `npm test`, `npm run typecheck`, and `npm run lint`. To list tools, run `node src/cli.ts` over stdio or `node src/cli.ts --http --port 3333` and point the client at `http://127.0.0.1:3333/mcp`.

Secrets you can add in Cursor, with no values here: `GITHUB_PERSONAL_ACCESS_TOKEN` (needed to create a task, read a task, or list models without `login`; not needed for CI or `tools/list`), `COPILOT_AGENTS_NOTIFY_URL` and `COPILOT_AGENTS_NOTIFY_AUTHORIZATION`. `COPILOT_AGENTS_GITHUB_APP_CLIENT_ID` is optional and not a secret: when unset, the client ID embedded in the code is used. `COPILOT_AGENTS_GITHUB_API_BASE_URL` overrides `https://api.github.com` for local fakes and E2E.