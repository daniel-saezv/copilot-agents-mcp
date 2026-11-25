import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "..", "scripts", "assert-on-main.sh");
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("assert-on-main", () => {
  it("accepts a commit on main", () => {
    const repo = repository();
    const mainCommit = git(repo, "rev-parse", "HEAD");

    const result = run(repo, mainCommit, "main");

    expect(result.status).toBe(0);
  });

  it("rejects a commit only on a side branch", () => {
    const repo = repository();
    git(repo, "checkout", "-b", "side");
    writeFileSync(join(repo, "side.txt"), "side\n");
    git(repo, "add", "side.txt");
    git(repo, "commit", "-m", "side");
    const sideCommit = git(repo, "rev-parse", "HEAD");

    const result = run(repo, sideCommit, "main");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`::error::Tagged commit ${sideCommit} is not on main; refusing to publish.`);
  });
});

function repository() {
  const directory = mkdtempSync(join(tmpdir(), "assert-on-main-"));
  directories.push(directory);
  git(directory, "init", "-b", "main");
  git(directory, "config", "user.name", "Test");
  git(directory, "config", "user.email", "test@example.com");
  writeFileSync(join(directory, "main.txt"), "main\n");
  git(directory, "add", "main.txt");
  git(directory, "commit", "-m", "main");
  return directory;
}

function run(cwd: string, sha: string, ref: string) {
  return spawnSync("bash", [script, sha, ref], { cwd, encoding: "utf8" });
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} exited ${result.status}`);
  }
  return result.stdout.trim();
}
