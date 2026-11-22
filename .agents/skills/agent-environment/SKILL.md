---
name: agent-environment
description: Make the cloud agent environment ready and consistent. One setup script, and a wrapper per provider that only calls it.
---

# Agent environment

Use this skill when the project has no prepared environment, when dependencies, the toolchain, or startup steps change, or when a cloud agent provider is in use and has no wrapper.

Provider paths, fields, and triggers are in [references/providers.md](references/providers.md). Do not copy that page into `AGENTS.md`.

## What to do

1. **Find the source of truth.** `scripts/setup` must exist at the repo root. If it does not, create it. The script is bash and runs `set -euo pipefail`. It changes to the repo root. `install_stack` sits between the markers `stack (project-setup)` and `end stack`. The script calls `install_stack` and exits 0. It is idempotent.
2. **Fill `install_stack` when you know the stack.** If a lockfile or pinned versions exist and you have run the install command, put that command inside `install_stack`. Do not install a stack you have not identified. If there is no stack, leave the message that there is nothing to install.
3. **Detect providers.** Note which of these the repo has.
   - A `.cursor/` directory or `.cursor/environment.json`.
   - `.github/copilot-instructions.md` or `.github/workflows/copilot-setup-steps.yml`.
   - Any other provider file listed in the reference.
   If the repo came from this template and those files are missing, add the two wrappers in the reference. Do not add a provider the project does not use.
4. **Write or update each wrapper.** A wrapper only runs `bash scripts/setup`. It has no install logic of its own. Match the reference for path, job name, fields, and triggers. If the project uses a provider from the reference and has no wrapper, add one.
5. **Check.** Run `bash scripts/setup` twice in a row. Both runs must exit 0. Open each wrapper and check that it calls the script and matches the reference. In Cursor, the proof is that `environment-info` or the Build log shows `install` ran, not that the file exists.

## What not to do

- Do not put install commands in a wrapper.
- Do not name a provider as required in `AGENTS.md`.
- Do not add a devcontainer unless the project already uses one as its development environment.
