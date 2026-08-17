import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe } from "vitest";
import type { GitExec, GitExecResult } from "../src/tools/git/execution.ts";
import type { GitToolContext } from "../src/tools/git/tool.ts";
import { createDirectoryTestFixtures } from "./directory-test-fixtures.ts";

export const gitIntegration =
  spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0 ? describe : describe.skip;

interface GitRepositoryFixture {
  readonly directory: string;
  readonly context: GitToolContext;
}

export function createGitIntegrationFixtures() {
  const directoryFixtures = createDirectoryTestFixtures();

  return {
    async createRepository(): Promise<GitRepositoryFixture> {
      const directory = await mkdtemp(join(tmpdir(), "bash-tools-git-"));
      directoryFixtures.trackDirectory(directory);
      await rawGit(directory, ["init", "--quiet"]);
      await rawGit(directory, ["config", "user.name", "Integration Test"]);
      await rawGit(directory, ["config", "user.email", "integration@example.test"]);
      await rawGit(directory, ["config", "commit.gpgsign", "false"]);
      await writeFile(join(directory, "README.md"), "initial README\n");
      await writeFile(join(directory, "space name.txt"), "initial space file\n");
      await writeFile(join(directory, "binary.bin"), Buffer.from([0, 1, 2, 3, 255]));
      await rawGit(directory, ["add", "."]);
      await rawGit(directory, ["commit", "--quiet", "-m", "initial commit"]);
      return {
        directory,
        context: { cwd: directory, signal: undefined },
      };
    },
    trackDirectory: directoryFixtures.trackDirectory,
    cleanup: directoryFixtures.cleanup,
  };
}

export function makeRealGitExec(onSpawn?: () => void): GitExec {
  return (command, args, options) =>
    new Promise<GitExecResult>((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: options?.cwd,
        shell: false,
        signal: options?.signal,
      });
      onSpawn?.();
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let killed = false;
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error: Error & { code?: string }) => {
        if (error.name === "AbortError" || error.code === "ABORT_ERR") {
          killed = true;
          return;
        }
        reject(error);
      });
      child.on("close", (code) => {
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          code: code ?? -1,
          killed,
        });
      });
    });
}

export async function rawGit(cwd: string, args: readonly string[]): Promise<string> {
  const result = await makeRealGitExec()("git", args, { cwd });
  if (result.code !== 0) {
    throw new Error(result.stderr || `git exited with ${result.code}`);
  }
  return result.stdout;
}

export async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function capabilityError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = error.code;
  return code === "EACCES" || code === "ENOTSUP" || code === "EPERM";
}
