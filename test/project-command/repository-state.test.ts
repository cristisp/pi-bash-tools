import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import type { GitExec, GitExecResult } from "../../src/tools/git/execution.ts";
import { createProjectCommandRepositoryStateReader } from "../../src/tools/project-command/repository-state.ts";
import {
  createGitIntegrationFixtures,
  gitIntegration,
  makeRealGitExec,
  rawGit,
} from "../git/integration-fixtures.ts";

const cwd = process.cwd();
const oversized = "x".repeat(2 * 1024 * 1024 + 1);
const gitFixtures = createGitIntegrationFixtures();

afterEach(async () => {
  await gitFixtures.cleanup();
});

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

function expectedDigest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part, "utf8").update("\0", "utf8");
  return hash.digest("hex");
}

function scriptedRepositoryExec(
  status: () => string,
  hashOutput: () => string = () => "",
  onHashPaths?: (paths: readonly string[]) => void,
): GitExec {
  return async (_command, args) => {
    const subcommand = args[3];
    if (subcommand === "rev-parse") {
      return result(args[4] === "--show-toplevel" ? `${await realpath(cwd)}\n` : "HEAD\n");
    }
    if (subcommand === "status") return result(status());
    if (subcommand === "hash-object") {
      onHashPaths?.(args.slice(5));
      return result(hashOutput());
    }
    return result("");
  };
}

function fileContentHashes(paths: readonly string[]): string {
  return paths
    .map((path) =>
      createHash("sha256")
        .update(readFileSync(join(cwd, path)))
        .digest("hex"),
    )
    .join("\n");
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

it("hashes only present paths for a mixed dirty state with a tracked deletion", async () => {
  const temporaryDirectory = await mkdtemp(join(cwd, ".repository-state-deletion-"));
  const relativeDirectory = temporaryDirectory.slice(cwd.length + 1);
  const modifiedPath = `${relativeDirectory}/modified.txt`;
  const untrackedPath = `${relativeDirectory}/untracked.txt`;
  const deletedPath = `${relativeDirectory}/gone.txt`;
  await writeFile(join(cwd, modifiedPath), "modified content\n", "utf8");
  await writeFile(join(cwd, untrackedPath), "untracked content\n", "utf8");
  const hashArguments: string[][] = [];
  const exec = scriptedRepositoryExec(
    () => ` M ${modifiedPath}\0?? ${untrackedPath}\0 D ${deletedPath}\0`,
    () => `${"a".repeat(40)}\n${"b".repeat(40)}\n`,
    (paths) => hashArguments.push([...paths]),
  );
  try {
    const reader = createProjectCommandRepositoryStateReader(exec);
    const state = await reader(cwd, undefined);
    expect(state?.dirtyFilesDigest).toBeDefined();
    expect(hashArguments).toEqual([[modifiedPath, untrackedPath]]);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

it("keeps hash alignment when a deletion is interleaved between present paths", async () => {
  const temporaryDirectory = await mkdtemp(join(cwd, ".repository-state-interleaved-"));
  const relativeDirectory = temporaryDirectory.slice(cwd.length + 1);
  const modifiedPath = `${relativeDirectory}/a.txt`;
  const untrackedPath = `${relativeDirectory}/b.txt`;
  const deletedPath = `${relativeDirectory}/gone.txt`;
  const status = ` M ${modifiedPath}\0 D ${deletedPath}\0?? ${untrackedPath}\0`;
  const hashArguments: string[][] = [];
  const exec = scriptedRepositoryExec(
    () => status,
    () => {
      const paths = hashArguments[hashArguments.length - 1] ?? [];
      return paths.length === 0 ? "" : `${fileContentHashes(paths)}\n`;
    },
    (paths) => hashArguments.push([...paths]),
  );
  try {
    await writeFile(join(cwd, modifiedPath), "modified-a", "utf8");
    await writeFile(join(cwd, untrackedPath), "untracked-a", "utf8");
    const reader = createProjectCommandRepositoryStateReader(exec);
    const initial = await reader(cwd, undefined);
    expect(initial?.dirtyFilesDigest).toBeDefined();
    await writeFile(join(cwd, modifiedPath), "modified-b", "utf8");
    const modifiedChange = await reader(cwd, undefined);
    expect(modifiedChange?.dirtyFilesDigest).not.toBe(initial?.dirtyFilesDigest);
    await writeFile(join(cwd, untrackedPath), "untracked-b", "utf8");
    const untrackedChange = await reader(cwd, undefined);
    expect(untrackedChange?.dirtyFilesDigest).not.toBe(modifiedChange?.dirtyFilesDigest);
    expect(hashArguments).toEqual([
      [modifiedPath, untrackedPath],
      [modifiedPath, untrackedPath],
      [modifiedPath, untrackedPath],
    ]);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

it("treats deletion-letter statuses as legitimately absent paths", async () => {
  const temporaryDirectory = await mkdtemp(join(cwd, ".repository-state-deletion-statuses-"));
  const relativeDirectory = temporaryDirectory.slice(cwd.length + 1);
  const deletedPath = `${relativeDirectory}/gone.txt`;
  const records: readonly (readonly [string, string])[] = [
    [" D", ""],
    ["D ", ""],
    ["MD", ""],
    ["AD", ""],
    ["DD", ""],
    ["RD", `${relativeDirectory}/original.txt`],
  ];
  let hashCalls = 0;
  try {
    const digests = await Promise.all(
      records.map(async ([status, originalPath]) => {
        const exec = scriptedRepositoryExec(
          () => `${status} ${deletedPath}\0${originalPath === "" ? "" : `${originalPath}\0`}`,
          () => {
            hashCalls += 1;
            return "";
          },
        );
        const reader = createProjectCommandRepositoryStateReader(exec);
        const state = await reader(cwd, undefined);
        return state?.dirtyFilesDigest;
      }),
    );
    expect(digests.every((digest) => digest !== undefined)).toBe(true);
    expect(hashCalls).toBe(0);
    expect(new Set(digests).size).toBe(records.length);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

it("hashes a present worktree file for unmerged UD and DU statuses", async () => {
  const temporaryDirectory = await mkdtemp(join(cwd, ".repository-state-unmerged-"));
  const relativeDirectory = temporaryDirectory.slice(cwd.length + 1);
  const conflictPath = `${relativeDirectory}/conflict.txt`;
  const filePath = join(cwd, conflictPath);
  const hashArguments: string[][] = [];
  let status = `UD ${conflictPath}\0`;
  const exec = scriptedRepositoryExec(
    () => status,
    () => {
      const paths = hashArguments[hashArguments.length - 1] ?? [];
      return paths.length === 0 ? "" : `${fileContentHashes(paths)}\n`;
    },
    (paths) => hashArguments.push([...paths]),
  );
  try {
    const reader = createProjectCommandRepositoryStateReader(exec);
    await writeFile(filePath, "conflict-a", "utf8");
    const firstUd = await reader(cwd, undefined);
    await writeFile(filePath, "conflict-b", "utf8");
    const secondUd = await reader(cwd, undefined);
    status = `DU ${conflictPath}\0`;
    const firstDu = await reader(cwd, undefined);
    await writeFile(filePath, "conflict-c", "utf8");
    const secondDu = await reader(cwd, undefined);
    expect(hashArguments).toEqual([[conflictPath], [conflictPath], [conflictPath], [conflictPath]]);
    expect(firstUd?.dirtyFilesDigest).toBeDefined();
    expect(secondUd?.dirtyFilesDigest).not.toBe(firstUd?.dirtyFilesDigest);
    expect(firstDu?.dirtyFilesDigest).toBeDefined();
    expect(secondDu?.dirtyFilesDigest).not.toBe(firstDu?.dirtyFilesDigest);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

it("resolves undefined when an unmerged UD or DU path is absent", async () => {
  const temporaryDirectory = await mkdtemp(join(cwd, ".repository-state-unmerged-absent-"));
  const relativeDirectory = temporaryDirectory.slice(cwd.length + 1);
  const absentPath = `${relativeDirectory}/missing.txt`;
  let status = `UD ${absentPath}\0`;
  const exec = scriptedRepositoryExec(() => status);
  try {
    const reader = createProjectCommandRepositoryStateReader(exec);
    await expect(reader(cwd, undefined)).resolves.toBeUndefined();
    status = `DU ${absentPath}\0`;
    await expect(reader(cwd, undefined)).resolves.toBeUndefined();
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

it("does not stat a deleted path even when a directory occupies that location", async () => {
  const temporaryDirectory = await mkdtemp(join(cwd, ".repository-state-deletion-stat-"));
  const relativeDirectory = temporaryDirectory.slice(cwd.length + 1);
  const deletedPath = `${relativeDirectory}/gone`;
  await mkdir(join(cwd, deletedPath));
  const exec = scriptedRepositoryExec(() => ` D ${deletedPath}\0`);
  try {
    const reader = createProjectCommandRepositoryStateReader(exec);
    const state = await reader(cwd, undefined);
    expect(state?.dirtyFilesDigest).toBeDefined();
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

it("includes deleted entries with fixed placeholder fields in the digest", async () => {
  const temporaryDirectory = await mkdtemp(join(cwd, ".repository-state-deletion-digest-"));
  const relativeDirectory = temporaryDirectory.slice(cwd.length + 1);
  const presentPath = `${relativeDirectory}/present.txt`;
  const deletedPath = `${relativeDirectory}/gone.txt`;
  await writeFile(join(cwd, presentPath), "present content\n", "utf8");
  const presentStat = await lstat(join(cwd, presentPath));
  const hash = "c".repeat(40);
  const status = ` M ${presentPath}\0 D ${deletedPath}\0`;
  const exec = scriptedRepositoryExec(
    () => status,
    () => `${hash}\n`,
  );
  try {
    const reader = createProjectCommandRepositoryStateReader(exec);
    const state = await reader(cwd, undefined);
    expect(state?.dirtyFilesDigest).toBe(
      expectedDigest([
        "status",
        status,
        "path",
        " M",
        presentPath,
        "",
        String(presentStat.mode),
        String(presentStat.size),
        hash,
        "path",
        " D",
        deletedPath,
        "",
        "0",
        "0",
        "deleted",
      ]),
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

it("changes the digest when a deleted path returns or a different path is deleted", async () => {
  const temporaryDirectory = await mkdtemp(join(cwd, ".repository-state-deletion-change-"));
  const relativeDirectory = temporaryDirectory.slice(cwd.length + 1);
  const firstPath = `${relativeDirectory}/first.txt`;
  const secondPath = `${relativeDirectory}/second.txt`;
  let currentStatus = ` D ${firstPath}\0`;
  let currentHashOutput = "";
  const exec = scriptedRepositoryExec(
    () => currentStatus,
    () => currentHashOutput,
  );
  try {
    const reader = createProjectCommandRepositoryStateReader(exec);
    const firstDeletion = await reader(cwd, undefined);
    currentStatus = ` D ${secondPath}\0`;
    const secondDeletion = await reader(cwd, undefined);
    expect(firstDeletion?.dirtyFilesDigest).toBeDefined();
    expect(secondDeletion?.dirtyFilesDigest).toBeDefined();
    expect(firstDeletion?.dirtyFilesDigest).not.toBe(secondDeletion?.dirtyFilesDigest);
    await writeFile(join(cwd, firstPath), "restored content\n", "utf8");
    currentStatus = ` M ${firstPath}\0`;
    currentHashOutput = `${"d".repeat(40)}\n`;
    const restored = await reader(cwd, undefined);
    expect(restored?.dirtyFilesDigest).toBeDefined();
    expect(restored?.dirtyFilesDigest).not.toBe(firstDeletion?.dirtyFilesDigest);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

it("hashes the destination of a rename record and keeps its original path in the digest", async () => {
  const temporaryDirectory = await mkdtemp(join(cwd, ".repository-state-rename-"));
  const relativeDirectory = temporaryDirectory.slice(cwd.length + 1);
  const destinationPath = `${relativeDirectory}/renamed.txt`;
  const originalPath = `${relativeDirectory}/original.txt`;
  await writeFile(join(cwd, destinationPath), "renamed content\n", "utf8");
  const destinationStat = await lstat(join(cwd, destinationPath));
  const hash = "e".repeat(40);
  const status = `R  ${destinationPath}\0${originalPath}\0`;
  const hashArguments: string[][] = [];
  const exec = scriptedRepositoryExec(
    () => status,
    () => `${hash}\n`,
    (paths) => hashArguments.push([...paths]),
  );
  try {
    const reader = createProjectCommandRepositoryStateReader(exec);
    const state = await reader(cwd, undefined);
    expect(hashArguments).toEqual([[destinationPath]]);
    expect(state?.dirtyFilesDigest).toBe(
      expectedDigest([
        "status",
        status,
        "path",
        "R ",
        destinationPath,
        originalPath,
        String(destinationStat.mode),
        String(destinationStat.size),
        hash,
      ]),
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

it("rejects a present path that is a directory", async () => {
  const temporaryDirectory = await mkdtemp(join(cwd, ".repository-state-directory-"));
  const relativeDirectory = temporaryDirectory.slice(cwd.length + 1);
  const directoryPath = `${relativeDirectory}/directory`;
  await mkdir(join(cwd, directoryPath));
  const exec = scriptedRepositoryExec(() => `?? ${directoryPath}\0`);
  try {
    const reader = createProjectCommandRepositoryStateReader(exec);
    await expect(reader(cwd, undefined)).resolves.toBeUndefined();
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

it("rejects mismatched or malformed hash output for present paths", async () => {
  const temporaryDirectory = await mkdtemp(join(cwd, ".repository-state-hash-"));
  const relativeDirectory = temporaryDirectory.slice(cwd.length + 1);
  const firstPath = `${relativeDirectory}/first.txt`;
  const secondPath = `${relativeDirectory}/second.txt`;
  await writeFile(join(cwd, firstPath), "first content\n", "utf8");
  await writeFile(join(cwd, secondPath), "second content\n", "utf8");
  const status = `?? ${firstPath}\0?? ${secondPath}\0`;
  let hashOutput = `${"f".repeat(40)}\n`;
  const exec = scriptedRepositoryExec(
    () => status,
    () => hashOutput,
  );
  try {
    const reader = createProjectCommandRepositoryStateReader(exec);
    await expect(reader(cwd, undefined)).resolves.toBeUndefined();
    hashOutput = `${"f".repeat(40)}\n${"g".repeat(39)}\n`;
    await expect(reader(cwd, undefined)).resolves.toBeUndefined();
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

it("rejects dirty status output beyond the path count and path byte caps", async () => {
  let currentStatus = `${Array.from({ length: 4_097 }, (_, index) => `?? missing-${index}.txt`).join("\0")}\0`;
  const exec = scriptedRepositoryExec(() => currentStatus);
  const reader = createProjectCommandRepositoryStateReader(exec);
  await expect(reader(cwd, undefined)).resolves.toBeUndefined();
  currentStatus = `?? ${"x".repeat(128 * 1024 + 1)}\0`;
  await expect(reader(cwd, undefined)).resolves.toBeUndefined();
});

gitIntegration("real git repository state", () => {
  it("reads a defined digest that covers a tracked worktree deletion", async () => {
    const repository = await gitFixtures.createRepository();
    const trackedPath = join(repository.directory, "README.md");
    await rm(trackedPath);
    const reader = createProjectCommandRepositoryStateReader(makeRealGitExec());
    const deleted = await reader(repository.directory, undefined);
    expect(deleted?.dirtyFilesDigest).toMatch(/^[0-9a-f]{64}$/u);
    await writeFile(trackedPath, "restored README\n", "utf8");
    const restored = await reader(repository.directory, undefined);
    expect(restored?.dirtyFilesDigest).toBeDefined();
    expect(restored?.dirtyFilesDigest).not.toBe(deleted?.dirtyFilesDigest);
  });

  it("reads a defined digest for a staged deletion", async () => {
    const repository = await gitFixtures.createRepository();
    await rawGit(repository.directory, ["rm", "--quiet", "space name.txt"]);
    const reader = createProjectCommandRepositoryStateReader(makeRealGitExec());
    const state = await reader(repository.directory, undefined);
    expect(state?.dirtyFilesDigest).toMatch(/^[0-9a-f]{64}$/u);
  });
});
