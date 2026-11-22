---
name: project-setup
description: First task in a repository created from this template. Fill in the project section of AGENTS.md, replace the README, and set CI and Dependabot from what the repository contains.
---

# Set up the project

Run this skill on the first task in a repository created from this template.

## What to do

1. **Read the repository.** Walk the tree, the package manifests, and the config that is already there. Infer the stack from those files.
2. **Run the commands.** Run install, build, test, and start. Record a command only after you have run it and seen the result.
3. **Fill in "This project" in `AGENTS.md`.** Say what the project is, the stack, where the code lives, and the commands you ran. Add practices that belong to this stack. Add a CI/CD section with the existing workflows, the required pull request checks, and where the project deploys if it deploys.
4. **Replace `README.md`.** Write the README for the project. Remove the template text. Do not describe skills or agents. Say what the project is, what it requires, and how to install, run, test, and deploy it. Add a **Set up the environment** section that runs `bash scripts/setup`. At most one line may point to `AGENTS.md` for agent rules.
5. **Prepare the agent environment.** Follow the `agent-environment` skill. Put the install command you verified inside `install_stack` in `scripts/setup`. Provider wrappers do not repeat that command.
6. **Dependabot.** If the repo has a package manifest, add that ecosystem to `.github/dependabot.yml`. Keep the `github-actions` entry when it still applies.
7. **CI.** If the stack has a build or test command, add a GitHub Actions workflow that runs it on each pull request. Do not add a generic workflow that fails because there is no stack. Leave `.github/workflows/skills.yml` in place. It validates `project-setup` and `agent-environment`.

## Rules

- Do not invent a command, version, or path you have not checked.
- Do not copy instructions from another project.
- If there is no code to build yet, write that down and leave CI until a command is real.
