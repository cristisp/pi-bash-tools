/* oxlint-disable typescript/no-unsafe-type-assertion */
import { expect, it } from "vitest";

import { createGitDiffTool } from "../../src/tools/git/diff/tool.ts";
import type { GitExec } from "../../src/tools/git/execution.ts";
import { createGitLogTool } from "../../src/tools/git/log/tool.ts";
import { createGitShowTool } from "../../src/tools/git/show/tool.ts";
import { createGitStatusTool } from "../../src/tools/git/status/tool.ts";
import type { GitToolContext } from "../../src/tools/git/tool.ts";

const cwd = process.cwd();
const context: GitToolContext = { cwd, signal: undefined };
const prefix = ["--no-optional-locks", "-c", "core.fsmonitor=false"];

function result(stdout = "", stderr = "", code = 0) {
  return { stdout, stderr, code, killed: false };
}

function recordingExec(calls: string[][]): GitExec {
  return async (_command, args) => {
    calls.push([...args]);
    if (args[3] === "rev-parse") {
      return args[4] === "--show-toplevel" ? result(`${cwd}\n`) : result("head-sha\n");
    }
    return result();
  };
}

it("treats an empty git_status path as omitted without mutating the request", async () => {
  const calls: string[][] = [];
  const params = { path: "", refresh: false };

  const response = await createGitStatusTool(recordingExec(calls)).execute(
    "call",
    params,
    undefined,
    undefined,
    context,
  );

  expect(calls.find((args) => args[3] === "status")).toEqual([
    ...prefix,
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
  ]);
  expect(params).toEqual({ path: "", refresh: false });
  expect(response.details).toMatchObject({ unchanged: false });
});

it("treats an empty git_log revision as omitted", async () => {
  const calls: string[][] = [];

  const response = await createGitLogTool(recordingExec(calls)).execute(
    "call",
    { maxEntries: 5, revision: "" },
    undefined,
    undefined,
    context,
  );

  const logArgs = calls.find((args) => args[3] === "log");
  expect(logArgs?.includes("")).toBe(false);
  expect(logArgs?.at(-1)).toBe("--");
  expect(response.details).toMatchObject({ entries: [] });
});

it("keeps the rejected git_show empty revision wording", async () => {
  const calls: string[][] = [];

  await expect(
    createGitShowTool(recordingExec(calls)).execute(
      "call",
      { revision: "", maxBytes: 1024 },
      undefined,
      undefined,
      context,
    ),
  ).rejects.toThrow(
    /revision must not be empty; action: Correct the revision field or request shape and retry\./u,
  );
  expect(calls.filter((args) => args[3] === "show")).toHaveLength(0);
});

it("treats an empty git_diff path as omitted next to paths", async () => {
  const calls: string[][] = [];

  await createGitDiffTool(recordingExec(calls)).execute(
    "call",
    { mode: "patch", path: "", paths: ["src"] },
    undefined,
    undefined,
    context,
  );

  const diffArgs = calls.find((args) => args[3] === "diff");
  expect(diffArgs?.includes("")).toBe(false);
  expect(diffArgs?.at(-1)).toBe("src");
});

it("never drops empty paths entries, which would widen the scope", async () => {
  const calls: string[][] = [];

  await expect(
    createGitDiffTool(recordingExec(calls)).execute(
      "call",
      { mode: "patch", paths: ["", "src"] },
      undefined,
      undefined,
      context,
    ),
  ).rejects.toThrow(/paths\[0\] must not be empty/u);
});

it("still rejects an unsupported empty revision field on git_status", async () => {
  const calls: string[][] = [];
  const request = { refresh: false, revision: "" };

  await expect(
    createGitStatusTool(recordingExec(calls)).execute(
      "call",
      request,
      undefined,
      undefined,
      context,
    ),
  ).rejects.toThrow(
    'unsupported request field "revision"; accepted shape: { path?: string, refresh?: boolean | "true" | "false" }',
  );
  expect(calls).toHaveLength(0);
});

it("treats an empty git_show path as omitted", async () => {
  const calls: string[][] = [];

  const response = await createGitShowTool(recordingExec(calls)).execute(
    "call",
    { revision: "HEAD", path: "", maxBytes: 1024 },
    undefined,
    undefined,
    context,
  );

  const showArgs = calls.find((args) => args[3] === "show");
  expect(showArgs?.includes("")).toBe(false);
  expect(response.details).toMatchObject({ output: { truncated: false } });
});

it("still rejects an unsupported empty revision field on git_diff", async () => {
  const calls: string[][] = [];
  const request = { paths: ["src"], revision: "" };

  await expect(
    createGitDiffTool(recordingExec(calls)).execute("call", request, undefined, undefined, context),
  ).rejects.toThrow(
    'unsupported request field "revision"; accepted shape: { mode?: "summary" | "patch", path?: string, paths?: string[], staged?: boolean, maxBytes?: integer }',
  );
  expect(calls).toHaveLength(0);
});

it("rejects an own __proto__ key instead of hiding it from the key guard", async () => {
  const calls: string[][] = [];
  const request: Record<string, unknown> = JSON.parse('{"path":"","__proto__":{"refresh":true}}');

  await expect(
    createGitStatusTool(recordingExec(calls)).execute(
      "call",
      request as never,
      undefined,
      undefined,
      context,
    ),
  ).rejects.toThrow(/unsupported request field "__proto__"/u);
  expect(calls).toHaveLength(0);
});
