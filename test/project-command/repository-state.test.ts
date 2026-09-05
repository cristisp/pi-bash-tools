import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { GitExec, GitExecResult } from "../../src/tools/git/execution.ts";
import { createProjectCommandRepositoryStateReader } from "../../src/tools/project-command/repository-state.ts";

const cwd = process.cwd();
const oversized = "x".repeat(2 * 1024 * 1024 + 1);

function result(stdout: string): GitExecResult {
  return { stdout, stderr: "", code: 0, killed: false };
}

function repositoryExec(
  overrides: Partial<Record<"status" | "hash-object", string>> = {},
): GitExec {
  return async (_command, args) => {
    const subcommand = args[3];
    if (subcommand === "rev-parse") {
      return result(args[4] === "--show-toplevel" ? `${await realpath(cwd)}\n` : "HEAD\n");
    }
    if (subcommand === "status" || subcommand === "hash-object") {
      return result(overrides[subcommand] ?? "");
    }
    return result("");
  };
}

it("rejects oversized status output before parsing it", async () => {
  const reader = createProjectCommandRepositoryStateReader(repositoryExec({ status: oversized }));
  await expect(reader(cwd, undefined)).resolves.toBeUndefined();
});

it("rejects oversized untracked hash output before parsing it", async () => {
  const reader = createProjectCommandRepositoryStateReader(
    repositoryExec({
      status: "?? test/verify/tool.test.ts\0",
      "hash-object": oversized,
    }),
  );
  await expect(reader(cwd, undefined)).resolves.toBeUndefined();
});

it("captures nested project paths relative to the repository root", async () => {
  const nestedProject = join(cwd, "test");
  let hashRound = 0;
  const exec: GitExec = async (_command, args, options) => {
    const subcommand = args[3];
    if (subcommand === "rev-parse") {
      return result(args[4] === "--show-toplevel" ? `${cwd}\n` : "HEAD\n");
    }
    if (subcommand === "status") {
      expect(options?.cwd).toBe(cwd);
      return result("?? test/verify/tool.test.ts\0 M AGENTS.md\0");
    }
    if (subcommand === "hash-object") {
      expect(options?.cwd).toBe(cwd);
      hashRound += 1;
      return result(`${"a".repeat(39)}${hashRound}\n${"b".repeat(40)}\n`);
    }
    return result("");
  };
  const reader = createProjectCommandRepositoryStateReader(exec);
  const first = await reader(nestedProject, undefined);
  const second = await reader(nestedProject, undefined);
  expect(first?.repositoryIdentity).toBe(await realpath(cwd));
  expect(first?.dirtyFilesDigest).toBeDefined();
  expect(second?.dirtyFilesDigest).toBeDefined();
  expect(second?.dirtyFilesDigest).not.toBe(first?.dirtyFilesDigest);
});

it("rejects a file that changes between stat and hashing", async () => {
  const temporaryDirectory = await mkdtemp(join(cwd, ".repository-state-race-"));
  const relativePath = `${temporaryDirectory.slice(cwd.length + 1)}/file.txt`;
  const filePath = join(cwd, relativePath);
  await writeFile(filePath, "before", "utf8");
  const exec: GitExec = async (_command, args) => {
    const subcommand = args[3];
    if (subcommand === "rev-parse") {
      return result(args[4] === "--show-toplevel" ? `${await realpath(cwd)}\n` : "HEAD\n");
    }
    if (subcommand === "status") return result(`?? ${relativePath}\0`);
    if (subcommand === "hash-object") {
      await writeFile(filePath, "after-the-stat", "utf8");
      return result(`${"a".repeat(40)}\n`);
    }
    return result("");
  };
  try {
    const reader = createProjectCommandRepositoryStateReader(exec);
    await expect(reader(cwd, undefined)).resolves.toBeUndefined();
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
