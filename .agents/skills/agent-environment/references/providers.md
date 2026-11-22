# Cloud agent environment providers

Facts for lookup. Checked on 2026-11-22 against the linked docs. If a field is not on this page, do not invent it. Open the link.

Wrappers only run `bash scripts/setup`.

## Cursor Cloud Agents

- Docs: [Cloud Environment Setup](https://cursor.com/docs/cloud-agent/setup)
- Builds (when `install` runs): [Cloud Agent Builds](https://cursor.com/docs/cloud-agent/builds)
- Schema: [environment.schema.json](https://cursor.com/schemas/environment.schema.json)
- Path: `.cursor/environment.json`
- Field: `install` (string). Cursor runs it from the project root while creating a Build, after the clone. It must be idempotent. Disk state is what a Build keeps. Live processes go in `start` or `terminals`.
- Minimum wrapper:

```json
{
  "install": "bash scripts/setup"
}
```

- Do not add `$schema`. The current schema sets `unevaluatedProperties` to false, so an unknown property is rejected.
- Do not add a Dockerfile, `start`, or `terminals` unless the stack needs them.
- A saved environment reads this file only when its environment.json location points at the file. On a single-repo start with no saved environment yet, a valid `.cursor/environment.json` in the repo is what gets registered. Self-hosted machines do not read the file.
- A Build clones each repo at its default branch and runs `install`. Until a Build has succeeded, agents start on the default image and skip that setup. Builds read configuration from the default branch. After you push a feature-branch edit, start an agent on that branch. Cursor checks the branch out on top of the active Build, and the agent can rerun `install` when dependencies changed. Trigger build, on the environment Builds tab, needs Write access to the repo.

## GitHub Copilot cloud agent

- Docs: [Configure the development environment for agents on GitHub Actions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-environment)
- Path: `.github/workflows/copilot-setup-steps.yml` on the default branch, or Copilot does not use it.
- One job. The job name is exactly `copilot-setup-steps`. Any other name is ignored.
- In a GitHub Actions session, Copilot runs that job's `steps` before it works. The job fields it honors are `steps`, `permissions`, `runs-on`, `services`, `snapshot`, and `timeout-minutes` (maximum 59). Other job fields are ignored.
- The file also runs as a normal Actions workflow. The docs example uses `workflow_dispatch`, plus `push` and `pull_request` when the workflow file itself changes, so the Actions tab and the pull request can show the result. This template also lists `scripts/setup` under `paths`, because the install logic lives in that script.
- `actions/checkout` is required when the steps run a file from the repo. Minimum permission is `contents: read`.
- Minimum wrapper: checkout (the same action and SHA as `.github/workflows/skills.yml`) and `run: bash scripts/setup`.
- This does not apply to Copilot sessions in a cloud sandbox. It applies to GitHub Actions sessions.
