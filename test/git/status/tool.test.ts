import { expect, it } from "vitest";
import { createGitStatusTool } from "../../../src/tools/git/status/tool.ts";
import type { GitExec } from "../../../src/tools/git/execution.ts";
import type { GitToolContext } from "../../../src/tools/git/tool.ts";

const cwd = process.cwd();
const context: GitToolContext = { cwd, signal: undefined };

function result(stdout = "", stderr = "", code = 0) {
  return { stdout, stderr, code, killed: false };
}

it("uses array arguments and returns structured renamed entries", async () => {
  const calls: string[][] = [];
  const exec: GitExec = async (_command, args) => {
    calls.push([...args]);
    if (args[3] === "rev-parse") return result(`${cwd}\n`);
    return result("R  new name.txt\0old name.txt\0?? untracked file.txt\0");
  };
  const tool = createGitStatusTool(exec);
  const response = await tool.execute("1", { path: "src" }, undefined, undefined, context);
  const details = response.details;
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
  ]);
  expect(details.entries[0]).toEqual({
    path: "new name.txt",
    indexStatus: "R",
    worktreeStatus: " ",
    renamedFrom: "old name.txt",
  });
  expect(details.output.truncated).toBe(false);
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
