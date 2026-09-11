import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import type { GitExec } from "../../../src/tools/git/execution.ts";
import type {
  GitStatusChangedOutput,
  GitStatusOutput,
} from "../../../src/tools/git/status/output.ts";
import { createGitStatusTool } from "../../../src/tools/git/status/tool.ts";
import type { GitToolContext } from "../../../src/tools/git/tool.ts";

const cwd = process.cwd();
const context: GitToolContext = { cwd, signal: undefined };

function changed(details: GitStatusOutput): GitStatusChangedOutput {
  if (details.unchanged) throw new Error("expected a rendered status");
  return details;
}

function result(stdout = "", stderr = "", code = 0) {
  return { stdout, stderr, code, killed: false };
}

it("uses array arguments and returns structured renamed entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "bash-tools-git-status-"));
  try {
    await writeFile(join(root, "new name.txt"), "renamed\n");
    await writeFile(join(root, "untracked file.txt"), "untracked\n");
    const calls: string[][] = [];
    const exec: GitExec = async (_command, args) => {
      calls.push([...args]);
      if (args[3] === "rev-parse") {
        return args[4] === "HEAD" ? result("head-sha-0123\n") : result(`${root}\n`);
      }
      if (args[3] === "hash-object") return result(`${"a".repeat(40)}\n${"b".repeat(40)}\n`);
      return result("R  new name.txt\0old name.txt\0?? untracked file.txt\0");
    };
    const tool = createGitStatusTool(exec);
    const response = await tool.execute("1", { path: "src" }, undefined, undefined, {
      cwd: root,
      signal: undefined,
    });
    const details = changed(response.details);
    expect(calls).toEqual([
      ["--no-optional-locks", "-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"],
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--",
        "src",
      ],
      ["--no-optional-locks", "-c", "core.fsmonitor=false", "rev-parse", "HEAD"],
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "hash-object",
        "--",
        "new name.txt",
        "untracked file.txt",
      ],
    ]);
    expect(details.head).toBe("head-sha-0123");
    expect(details.dirtyFilesDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(details.entries[0]).toEqual({
      path: "new name.txt",
      indexStatus: "R",
      worktreeStatus: " ",
      renamedFrom: "old name.txt",
    });
    expect(details.output.truncated).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("returns a compact unchanged response and supports the refresh escape hatch", async () => {
  const calls: string[][] = [];
  const exec: GitExec = async (_command, args) => {
    calls.push([...args]);
    return args[3] === "rev-parse" ? result(`${cwd}\n`) : result(" M same.txt\0");
  };
  const tool = createGitStatusTool(exec);
  const first = await tool.execute("first", {}, undefined, undefined, context);
  const unchanged = await tool.execute("unchanged", {}, undefined, undefined, context);
  expect(unchanged.details).toMatchObject({
    repositoryRoot: cwd,
    unchanged: true,
    previous: { digest: expect.any(String), entryCount: 1 },
    message: expect.stringContaining("refresh: true"),
  });
  expect(unchanged.details).not.toHaveProperty("entries");
  expect(first.details).toMatchObject({ unchanged: false });

  const refreshed = await tool.execute(
    "refresh",
    { refresh: "true" },
    undefined,
    undefined,
    context,
  );
  expect(refreshed.details).toMatchObject({ unchanged: false, entries: [{ path: "same.txt" }] });
  expect(calls.filter((args) => args[3] === "status")).toHaveLength(3);
});

it("evicts the oldest previous status entries beyond the process-local cap", async () => {
  const exec: GitExec = async (_command, args) => {
    return args[3] === "rev-parse" ? result(`${cwd}\n`) : result(" M same.txt\0");
  };
  const tool = createGitStatusTool(exec);
  for (let index = 0; index < 257; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    const response = await tool.execute(
      `fill-${index}`,
      { path: `dir-${index}` },
      undefined,
      undefined,
      context,
    );
    expect(response.details).toMatchObject({ unchanged: false });
  }

  const evicted = await tool.execute("evicted", { path: "dir-0" }, undefined, undefined, context);
  expect(evicted.details).toMatchObject({ unchanged: false });

  const recent = await tool.execute("recent", { path: "dir-256" }, undefined, undefined, context);
  expect(recent.details).toMatchObject({
    unchanged: true,
    previous: { entryCount: 1 },
  });
});

it("carries repository-state identity without a hash-object process on a clean tree", async () => {
  const calls: string[][] = [];
  const exec: GitExec = async (_command, args) => {
    calls.push([...args]);
    if (args[3] === "rev-parse") {
      return args[4] === "HEAD" ? result("head-sha-clean\n") : result(`${cwd}\n`);
    }
    return result("");
  };
  const details = changed(
    (await createGitStatusTool(exec).execute("clean", {}, undefined, undefined, context)).details,
  );
  expect(details.head).toBe("head-sha-clean");
  expect(details.dirtyFilesDigest).toMatch(/^[0-9a-f]{64}$/u);
  expect(calls.filter((args) => args[3] === "hash-object")).toHaveLength(0);
  expect(calls.filter((args) => args[3] === "rev-parse" && args[4] === "HEAD")).toHaveLength(1);
});

it("hashes dirty file content through a bounded hash-object process", async () => {
  const root = await mkdtemp(join(tmpdir(), "bash-tools-git-status-"));
  try {
    await writeFile(join(root, "dirty.txt"), "dirty\n");
    const calls: string[][] = [];
    const exec: GitExec = async (_command, args) => {
      calls.push([...args]);
      if (args[3] === "rev-parse") {
        return args[4] === "HEAD" ? result("head-sha-dirty\n") : result(`${root}\n`);
      }
      if (args[3] === "hash-object") return result(`${"c".repeat(40)}\n`);
      return result(" M dirty.txt\0");
    };
    const details = changed(
      (
        await createGitStatusTool(exec).execute("dirty", {}, undefined, undefined, {
          cwd: root,
          signal: undefined,
        })
      ).details,
    );
    expect(details.head).toBe("head-sha-dirty");
    expect(details.dirtyFilesDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(calls.filter((args) => args[3] === "hash-object")).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("omits identity fields when their computation fails", async () => {
  const exec: GitExec = async (_command, args) => {
    if (args[3] === "rev-parse") {
      return args[4] === "HEAD" ? result("", "fatal: bad object", 128) : result(`${cwd}\n`);
    }
    if (args[3] === "hash-object") return result("", "fatal: unable", 128);
    return result(" M dirty.txt\0");
  };
  const details = changed(
    (await createGitStatusTool(exec).execute("failing-identity", {}, undefined, undefined, context))
      .details,
  );
  expect(details.head).toBeUndefined();
  expect(details.dirtyFilesDigest).toBeUndefined();
});

it("carries stored identity in the unchanged previous reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "bash-tools-git-status-"));
  try {
    await writeFile(join(root, "same.txt"), "same\n");
    const exec: GitExec = async (_command, args) => {
      if (args[3] === "rev-parse") {
        return args[4] === "HEAD" ? result("head-sha-kept\n") : result(`${root}\n`);
      }
      if (args[3] === "hash-object") return result(`${"d".repeat(40)}\n`);
      return result(" M same.txt\0");
    };
    const tool = createGitStatusTool(exec);
    const first = changed(
      (await tool.execute("first", {}, undefined, undefined, { cwd: root, signal: undefined }))
        .details,
    );
    const unchanged = await tool.execute("second", {}, undefined, undefined, {
      cwd: root,
      signal: undefined,
    });
    expect(unchanged.details).toMatchObject({
      unchanged: true,
      previous: {
        digest: expect.any(String),
        entryCount: 1,
        head: first.head,
        dirtyFilesDigest: first.dirtyFilesDigest,
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects a path that escapes the workspace", async () => {
  const exec: GitExec = async (_command, args) =>
    args[3] === "rev-parse" ? result(`${cwd}\n`) : result();
  await expect(
    createGitStatusTool(exec).execute("1", { path: "../outside" }, undefined, undefined, context),
  ).rejects.toThrow(/workspace-relative/iu);
});

it("reports Git failures and cancellation", async () => {
  const failed: GitExec = async (_command, args) =>
    args[3] === "rev-parse" ? result("", "not a repository", 128) : result();
  await expect(
    createGitStatusTool(failed).execute("1", {}, undefined, undefined, context),
  ).rejects.toThrow(/not a repository/iu);

  const controller = new AbortController();
  controller.abort();
  await expect(
    createGitStatusTool(failed).execute("1", {}, controller.signal, undefined, context),
  ).rejects.toThrow(/cancelled/iu);
});
