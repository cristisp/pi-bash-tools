import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createGitDiffTool, DEFAULT_GIT_DIFF_MAX_BYTES } from "../../../src/tools/git/diff/tool.ts";
import type {
  GitDiffOutput,
  GitDiffPatchOutput,
  GitDiffSummaryOutput,
} from "../../../src/tools/git/diff/output.ts";
import {
  MAX_CONTENT_BYTES,
  MAX_RECORDS,
  STRUCTURED_OUTPUT_LIMIT,
} from "../../../src/tools/git/output.ts";
import type { GitExec } from "../../../src/tools/git/execution.ts";
import type { GitToolContext } from "../../../src/tools/git/tool.ts";

const cwd = process.cwd();
const context: GitToolContext = { cwd, signal: undefined };
const result = (stdout = "", stderr = "", code = 0) => ({ stdout, stderr, code, killed: false });

function patchDetails(details: GitDiffOutput): GitDiffPatchOutput {
  if (details.mode !== "patch") throw new Error("expected a patch response");
  return details;
}

function summaryDetails(details: GitDiffOutput): GitDiffSummaryOutput {
  if (details.mode !== "summary") throw new Error("expected a summary response");
  return details;
}

function patchExec(stdout = ""): { exec: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: GitExec = async (_command, args) => {
    calls.push([...args]);
    return args[3] === "rev-parse" ? result(`${cwd}\n`) : result(stdout);
  };
  return { exec, calls };
}

it("supports explicit staged patches and paths containing spaces", async () => {
  const { exec, calls } = patchExec("diff --git a/file name.txt b/file name.txt\n");
  const response = await createGitDiffTool(exec).execute(
    "1",
    { mode: "patch", staged: true, paths: ["src", "README.md"], maxBytes: 1024 },
    undefined,
    undefined,
    context,
  );
  expect(calls[1]).toEqual([
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    "--cached",
    "--",
    "src",
    "README.md",
  ]);
  expect(calls.some((call) => call[3] === "status")).toBe(false);
  expect(patchDetails(response.details).patch).toContain("file name.txt");
  expect(response.details.output).toEqual({
    truncated: false,
    totalBytes: Buffer.byteLength("diff --git a/file name.txt b/file name.txt\n", "utf8"),
    totalLines: 1,
  });
});

it("keeps strict, mutually exclusive path schema variants with an optional mode and limit", () => {
  type SchemaVariant = {
    readonly additionalProperties?: boolean;
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
  };
  const schema = createGitDiffTool(patchExec().exec).parameters as {
    readonly anyOf?: readonly SchemaVariant[];
  };
  const variants = schema.anyOf ?? [];

  expect(variants).toHaveLength(3);
  expect(variants.every((variant) => variant.additionalProperties === false)).toBe(true);
  expect(variants.map((variant) => Object.keys(variant.properties ?? {}).sort())).toEqual([
    ["maxBytes", "mode", "staged"],
    ["maxBytes", "mode", "path", "staged"],
    ["maxBytes", "mode", "paths", "staged"],
  ]);
  expect(variants.map((variant) => [...(variant.required ?? [])].sort())).toEqual([
    [],
    ["path"],
    ["paths"],
  ]);
  expect(variants.every((variant) => !variant.required?.includes("maxBytes"))).toBe(true);
  expect(variants[0]?.properties?.mode).toMatchObject({
    anyOf: [{ const: "summary" }, { const: "patch" }],
  });
});

it("defaults to a bounded summary with status, stat, and hunk headers but no body", async () => {
  const calls: string[][] = [];
  const exec: GitExec = async (_command, args) => {
    calls.push([...args]);
    if (args[3] === "rev-parse") return result(`${cwd}\n`);
    if (args[3] === "status") return result(" M README.md\0?? new.txt\0");
    if (args.includes("--stat")) {
      return result(" README.md | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n");
    }
    return result(
      "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@ heading\n-old body\n+new body\n",
    );
  };
  const response = await createGitDiffTool(exec).execute(
    "summary",
    {},
    undefined,
    undefined,
    context,
  );

  expect(response.details).toMatchObject({
    mode: "summary",
    status: [
      { path: "README.md", indexStatus: " ", worktreeStatus: "M" },
      { path: "new.txt", indexStatus: " ", worktreeStatus: "?" },
    ],
    stat: expect.stringContaining("README.md"),
    hunks: [{ path: "README.md", header: "@@ -1 +1 @@ heading" }],
    output: { truncated: false },
    message: expect.stringContaining("hunk bodies are omitted"),
  });
  expect(JSON.stringify(response.details)).not.toContain("old body");
  expect(JSON.stringify(response.details)).not.toContain("new body");
  expect(calls.slice(1).map((call) => call[3])).toEqual([
    "status",
    "rev-parse",
    "diff",
    "diff",
    "diff",
  ]);
  expect(calls.find((call) => call.includes("--stat"))).toEqual([
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--stat",
    "--",
  ]);
});

it("reuses an unchanged summary and misses after the working tree changes", async () => {
  const statusOutput = " M README.md\0";
  let diffText = "diff --git a/README.md b/README.md\n@@ -1 +1 @@\n";
  let rawText = "raw-a";
  let statCalls = 0;
  let hunkCalls = 0;
  const exec: GitExec = async (_command, args) => {
    if (args[3] === "rev-parse") {
      return result(args[4] === "--show-toplevel" ? `${cwd}\n` : "head-a\n");
    }
    if (args[3] === "status") return result(statusOutput);
    if (args.includes("--raw")) return result(rawText);
    if (args.includes("--stat")) {
      statCalls += 1;
      return result(" README.md | 1 +\n");
    }
    hunkCalls += 1;
    return result(diffText);
  };
  const tool = createGitDiffTool(exec);

  const first = await tool.execute("first", {}, undefined, undefined, context);
  const second = await tool.execute("second", {}, undefined, undefined, context);
  expect(second.details).toEqual(first.details);
  expect(statCalls).toBe(1);
  expect(hunkCalls).toBe(1);

  diffText = "diff --git a/README.md b/README.md\n@@ -2 +2 @@\n";
  rawText = "raw-b";
  await tool.execute("changed", {}, undefined, undefined, context);
  expect(statCalls).toBe(2);
  expect(hunkCalls).toBe(2);
});

it("invalidates an unchanged untracked status when file content changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "bash-tools-git-diff-untracked-"));
  try {
    await writeFile(join(root, "new.txt"), "first");
    let hunkCalls = 0;
    let statCalls = 0;
    const exec: GitExec = async (_command, args) => {
      if (args[3] === "rev-parse") {
        return args[4] === "--show-toplevel" ? result(`${root}\n`) : result("head-a\n");
      }
      if (args[3] === "status") return result("?? new.txt\0");
      if (args.includes("--raw")) return result("");
      if (args.includes("--unified=0")) {
        hunkCalls += 1;
        return result(`diff-${hunkCalls}`);
      }
      statCalls += 1;
      return result(`stat-${statCalls}`);
    };
    const tool = createGitDiffTool(exec);
    const localContext: GitToolContext = { cwd: root, signal: undefined };
    await tool.execute("untracked-first", {}, undefined, undefined, localContext);
    await writeFile(join(root, "new.txt"), "second");
    await tool.execute("untracked-second", {}, undefined, undefined, localContext);

    expect(hunkCalls).toBe(2);
    expect(statCalls).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("deduplicates concurrent summary execution for one cache state", async () => {
  const statusOutput = " M README.md\0";
  let hunkCalls = 0;
  let statCalls = 0;
  let statusCalls = 0;
  let rawCalls = 0;
  let releaseRaw: (() => void) | undefined;
  let releaseHunk: (() => void) | undefined;
  let signalRawStarted: (() => void) | undefined;
  let signalHunkStarted: (() => void) | undefined;
  let signalSecondReady: (() => void) | undefined;
  const rawStarted = new Promise<void>((resolve) => {
    signalRawStarted = resolve;
  });
  const hunkStarted = new Promise<void>((resolve) => {
    signalHunkStarted = resolve;
  });
  const secondReady = new Promise<void>((resolve) => {
    signalSecondReady = resolve;
  });
  const rawReleased = new Promise<void>((resolve) => {
    releaseRaw = resolve;
  });
  const hunkReleased = new Promise<void>((resolve) => {
    releaseHunk = resolve;
  });
  const exec: GitExec = async (_command, args) => {
    if (args[3] === "rev-parse") {
      if (args[4] === "HEAD") {
        if (statusCalls === 2) signalSecondReady?.();
        return result("head-a\n");
      }
      return result(`${cwd}\n`);
    }
    if (args[3] === "status") {
      statusCalls += 1;
      return result(statusOutput);
    }
    if (args.includes("--raw")) {
      rawCalls += 1;
      signalRawStarted?.();
      await rawReleased;
      return result("raw-state");
    }
    if (args.includes("--unified=0")) {
      hunkCalls += 1;
      signalHunkStarted?.();
      await hunkReleased;
      return result("diff --git a/README.md b/README.md\n@@ -1 +1 @@\n");
    }
    statCalls += 1;
    return result(" README.md | 1 +\n");
  };
  const tool = createGitDiffTool(exec);
  const first = tool.execute("concurrent-first", {}, undefined, undefined, context);
  await rawStarted;
  const second = tool.execute("concurrent-second", {}, undefined, undefined, context);
  await secondReady;
  releaseRaw?.();
  await hunkStarted;
  releaseHunk?.();
  await Promise.all([first, second]);

  expect(rawCalls).toBe(1);
  expect(hunkCalls).toBe(1);
  expect(statCalls).toBe(1);
});

it("does not let a cancelled raw-discovery owner cancel an active waiter", async () => {
  let statusCalls = 0;
  let rawCalls = 0;
  let hunkCalls = 0;
  let statCalls = 0;
  let signalRawStarted: (() => void) | undefined;
  let releaseRaw: (() => void) | undefined;
  let signalSecondReady: (() => void) | undefined;
  const rawStarted = new Promise<void>((resolve) => {
    signalRawStarted = resolve;
  });
  const rawReleased = new Promise<void>((resolve) => {
    releaseRaw = resolve;
  });
  const secondReady = new Promise<void>((resolve) => {
    signalSecondReady = resolve;
  });
  const exec: GitExec = async (_command, args) => {
    if (args[3] === "rev-parse") return result(`${cwd}\n`);
    if (args[3] === "status") {
      statusCalls += 1;
      if (statusCalls === 2) signalSecondReady?.();
      return result(" M README.md\0");
    }
    if (args.includes("--raw")) {
      rawCalls += 1;
      signalRawStarted?.();
      await rawReleased;
      return result("raw-state");
    }
    if (args.includes("--unified=0")) {
      hunkCalls += 1;
      return result("diff --git a/README.md b/README.md\n@@ -1 +1 @@\n");
    }
    statCalls += 1;
    return result(" README.md | 1 +\n");
  };
  const tool = createGitDiffTool(exec);
  const controller = new AbortController();
  const first = tool.execute("raw-cancelled", {}, undefined, undefined, {
    cwd,
    signal: controller.signal,
  });
  await rawStarted;
  const second = tool.execute("raw-waiter", {}, undefined, undefined, context);
  await secondReady;
  controller.abort();
  releaseRaw?.();

  await expect(first).rejects.toMatchObject({
    contract: { code: "cancelled", category: "CANCELLED" },
  });
  await second;
  expect(rawCalls).toBe(1);
  expect(hunkCalls).toBe(1);
  expect(statCalls).toBe(1);
});

it("does not let an aborted summary waiter break the active single-flight owner", async () => {
  let hunkCalls = 0;
  let statCalls = 0;
  let signalHunkStarted: (() => void) | undefined;
  let releaseHunk: (() => void) | undefined;
  const hunkStarted = new Promise<void>((resolve) => {
    signalHunkStarted = resolve;
  });
  const hunkReleased = new Promise<void>((resolve) => {
    releaseHunk = resolve;
  });
  const exec: GitExec = async (_command, args) => {
    if (args[3] === "rev-parse") return result(`${cwd}\n`);
    if (args[3] === "status") return result(" M README.md\0");
    if (args.includes("--raw")) return result("raw-state");
    if (args.includes("--unified=0")) {
      hunkCalls += 1;
      signalHunkStarted?.();
      if (hunkCalls === 1) await hunkReleased;
      return result("diff --git a/README.md b/README.md\n@@ -1 +1 @@\n");
    }
    statCalls += 1;
    return result(" README.md | 1 +\n");
  };
  const tool = createGitDiffTool(exec);
  const first = tool.execute("single-flight-first", {}, undefined, undefined, context);
  await hunkStarted;

  const controller = new AbortController();
  const second = tool.execute("single-flight-aborted", {}, undefined, undefined, {
    cwd,
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await expect(second).rejects.toMatchObject({
    contract: { code: "cancelled", category: "CANCELLED" },
  });

  const third = tool.execute("single-flight-third", {}, undefined, undefined, context);
  releaseHunk?.();
  await Promise.all([first, third]);

  expect(hunkCalls).toBe(1);
  expect(statCalls).toBe(1);
});

it("filters summary status to the selected staged or worktree column", async () => {
  const statusOutput = "MM mixed.txt\0M  staged-only.txt\0 M worktree-only.txt\0?? untracked.txt\0";
  const run = async (staged: boolean) => {
    const calls: string[][] = [];
    const exec: GitExec = async (_command, args) => {
      calls.push([...args]);
      if (args[3] === "rev-parse") return result(`${cwd}\n`);
      if (args[3] === "status") return result(statusOutput);
      if (args.includes("--stat")) return result("stat\n");
      return result("diff --git a/mixed.txt b/mixed.txt\n@@ -1 +1 @@\n");
    };
    const response = await createGitDiffTool(exec).execute(
      staged ? "staged-summary" : "worktree-summary",
      { staged, maxBytes: 1024 },
      undefined,
      undefined,
      context,
    );
    return { response, calls };
  };

  const staged = await run(true);
  expect(summaryDetails(staged.response.details).status).toEqual([
    { path: "mixed.txt", indexStatus: "M", worktreeStatus: " " },
    { path: "staged-only.txt", indexStatus: "M", worktreeStatus: " " },
  ]);
  expect(staged.calls[1]).not.toContain("--cached");
  expect(staged.calls[2]).not.toContain("--cached");
  expect(staged.calls[3]).toContain("--cached");
  expect(staged.calls[4]).toContain("--cached");

  const worktree = await run(false);
  expect(summaryDetails(worktree.response.details).status).toEqual([
    { path: "mixed.txt", indexStatus: " ", worktreeStatus: "M" },
    { path: "worktree-only.txt", indexStatus: " ", worktreeStatus: "M" },
    { path: "untracked.txt", indexStatus: " ", worktreeStatus: "?" },
  ]);
  expect(worktree.calls[3]).not.toContain("--cached");
  expect(worktree.calls[4]).not.toContain("--cached");
});

it("retains rename origins only for a selected rename or copy status", async () => {
  const statusOutput =
    "RM staged-rename.txt\0old-staged.txt\0MR worktree-rename.txt\0old-worktree.txt\0";
  const exec: GitExec = async (_command, args) => {
    if (args[3] === "rev-parse") return result(`${cwd}\n`);
    if (args[3] === "status") return result(statusOutput);
    if (args.includes("--stat")) return result("");
    return result("");
  };

  const staged = await createGitDiffTool(exec).execute(
    "staged-rename",
    { staged: true, maxBytes: 1024 },
    undefined,
    undefined,
    context,
  );
  expect(summaryDetails(staged.details).status).toEqual([
    {
      path: "staged-rename.txt",
      indexStatus: "R",
      worktreeStatus: " ",
      renamedFrom: "old-staged.txt",
    },
    { path: "worktree-rename.txt", indexStatus: "M", worktreeStatus: " " },
  ]);

  const worktree = await createGitDiffTool(exec).execute(
    "worktree-rename",
    { maxBytes: 1024 },
    undefined,
    undefined,
    context,
  );
  expect(summaryDetails(worktree.details).status).toEqual([
    { path: "staged-rename.txt", indexStatus: " ", worktreeStatus: "M" },
    {
      path: "worktree-rename.txt",
      indexStatus: " ",
      worktreeStatus: "R",
      renamedFrom: "old-worktree.txt",
    },
  ]);
});

it("keeps complete status metadata while returning at most MAX_RECORDS entries", async () => {
  const makeStatus = (count: number) =>
    Array.from({ length: count }, (_, index) => `M  record-${index}-${"x".repeat(30)}.txt\0`).join(
      "",
    );
  const run = async (count: number) => {
    const statusOutput = makeStatus(count);
    const exec: GitExec = async (_command, args) => {
      if (args[3] === "rev-parse") return result(`${cwd}\n`);
      if (args[3] === "status") return result(statusOutput);
      return result("");
    };
    return createGitDiffTool(exec).execute(
      `records-${count}`,
      { staged: true, maxBytes: MAX_CONTENT_BYTES },
      undefined,
      undefined,
      context,
    );
  };

  const exact = await run(MAX_RECORDS);
  const over = await run(MAX_RECORDS + 1);
  expect(Buffer.byteLength(makeStatus(MAX_RECORDS + 1), "utf8")).toBeGreaterThan(
    STRUCTURED_OUTPUT_LIMIT,
  );
  const completeStatus = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      path: `record-${index}-${"x".repeat(30)}.txt`,
      indexStatus: "M",
      worktreeStatus: " ",
    }));
  const expectedBytes = (count: number) =>
    Buffer.byteLength(
      JSON.stringify({ status: completeStatus(count), stat: "", hunks: [] }),
      "utf8",
    );

  expect(summaryDetails(exact.details).status).toHaveLength(MAX_RECORDS);
  expect(exact.details.output).toEqual({
    truncated: false,
    totalBytes: expectedBytes(MAX_RECORDS),
    totalLines: 1,
  });
  expect(summaryDetails(over.details).status).toHaveLength(MAX_RECORDS);
  expect(over.details.output).toEqual({
    truncated: true,
    totalBytes: expectedBytes(MAX_RECORDS + 1),
    totalLines: 1,
  });
  expect(over.details.message).toMatch(/INCOMPLETE/iu);
});

it("uses complete multibyte summary metadata when maxBytes bounds the display", async () => {
  const statusOutput = " M café-路径.txt\0";
  const stat = ` café-路径.txt | 2 +-
`;
  const exec: GitExec = async (_command, args) => {
    if (args[3] === "rev-parse") return result(`${cwd}\n`);
    if (args[3] === "status") return result(statusOutput);
    if (args.includes("--stat")) return result(stat);
    return result("diff --git a/café-路径.txt b/café-路径.txt\n@@ -1 +1 @@\n-old\n+new\n");
  };
  const completeStatus = [{ path: "café-路径.txt", indexStatus: " ", worktreeStatus: "M" }];
  const completeHunks = [{ path: "café-路径.txt", header: "@@ -1 +1 @@" }];
  const completeText = JSON.stringify({
    status: completeStatus,
    stat,
    hunks: completeHunks,
  });

  const bounded = await createGitDiffTool(exec).execute(
    "multibyte-bounded",
    { maxBytes: Buffer.byteLength(completeText, "utf8") - 1 },
    undefined,
    undefined,
    context,
  );
  expect(bounded.details.output).toEqual({
    truncated: true,
    totalBytes: Buffer.byteLength(completeText, "utf8"),
    totalLines: 1,
  });
  expect(JSON.stringify(bounded.details)).not.toContain("-old");
  expect(JSON.stringify(bounded.details)).not.toContain("+new");

  const complete = await createGitDiffTool(exec).execute(
    "multibyte-complete",
    { maxBytes: Buffer.byteLength(completeText, "utf8") },
    undefined,
    undefined,
    context,
  );
  expect(complete.details.output).toEqual({
    truncated: false,
    totalBytes: Buffer.byteLength(completeText, "utf8"),
    totalLines: 1,
  });
});

it("supports omitted, single, and multiple path filters for explicit patches", async () => {
  const wholeRepository = patchExec();
  await createGitDiffTool(wholeRepository.exec).execute(
    "whole",
    { mode: "patch", maxBytes: 1024 },
    undefined,
    undefined,
    context,
  );
  expect(wholeRepository.calls[1].slice(-1)).toEqual(["--"]);

  const onePath = patchExec();
  await createGitDiffTool(onePath.exec).execute(
    "one",
    { mode: "patch", paths: ["src"], maxBytes: 1024 },
    undefined,
    undefined,
    context,
  );
  expect(onePath.calls[1].slice(-2)).toEqual(["--", "src"]);

  const multiplePaths = patchExec();
  await createGitDiffTool(multiplePaths.exec).execute(
    "multiple",
    { mode: "patch", paths: ["src", "README.md"], maxBytes: 1024 },
    undefined,
    undefined,
    context,
  );
  expect(multiplePaths.calls[1].slice(-3)).toEqual(["--", "src", "README.md"]);
});

it("preserves legacy single-path patch compatibility", async () => {
  const { exec, calls } = patchExec("legacy diff\n");
  const response = await createGitDiffTool(exec).execute(
    "legacy",
    { mode: "patch", path: "src", staged: true, maxBytes: 1024 },
    undefined,
    undefined,
    context,
  );
  expect(calls[1]).toEqual([
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    "--cached",
    "--",
    "src",
  ]);
  expect(patchDetails(response.details).patch).toBe("legacy diff\n");
  expect(response.details.output).toEqual({
    truncated: false,
    totalBytes: Buffer.byteLength("legacy diff\n", "utf8"),
    totalLines: 1,
  });
});

it("uses the stable default summary limit and explicitly describes patch truncation", async () => {
  const { exec } = patchExec("0123456789abcdef");
  const summary = await createGitDiffTool(exec).execute(
    "summary-default",
    {},
    undefined,
    undefined,
    context,
  );
  expect(DEFAULT_GIT_DIFF_MAX_BYTES).toBe(16 * 1024);
  expect(summary.details.mode).toBe("summary");

  const long = patchExec("0123456789abcdef");
  const response = await createGitDiffTool(long.exec).execute(
    "patch-truncated",
    { mode: "patch", maxBytes: 5 },
    undefined,
    undefined,
    context,
  );
  expect(patchDetails(response.details).patch).toBe("01234");
  expect(response.details.output).toEqual({ truncated: true, totalBytes: 16, totalLines: 1 });
  expect(response.details.message).toMatch(/INCOMPLETE|larger maxBytes/iu);
});

it("returns empty and binary-safe explicit patches", async () => {
  const empty = patchExec();
  const emptyResponse = await createGitDiffTool(empty.exec).execute(
    "empty",
    { mode: "patch", maxBytes: 100 },
    undefined,
    undefined,
    context,
  );
  expect(patchDetails(emptyResponse.details).patch).toBe("");

  const binary = patchExec("Binary files a/x and b/x differ\n");
  const binaryResponse = await createGitDiffTool(binary.exec).execute(
    "binary",
    { mode: "patch", maxBytes: 100 },
    undefined,
    undefined,
    context,
  );
  expect(patchDetails(binaryResponse.details).patch).toContain("Binary files");
});
