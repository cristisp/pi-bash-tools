import { expect, it } from "vitest";
import { createGitDiffTool } from "../../../src/tools/git/diff/tool.ts";
import type { GitExec } from "../../../src/tools/git/execution.ts";
import type { GitToolContext } from "../../../src/tools/git/tool.ts";

const cwd = process.cwd();
const context: GitToolContext = { cwd, signal: undefined };
const result = (stdout = "", stderr = "", code = 0) => ({ stdout, stderr, code, killed: false });

function successfulExec(stdout: string): { exec: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: GitExec = async (_command, args) => {
    calls.push([...args]);
    return args[3] === "rev-parse" ? result(`${cwd}\n`) : result(stdout);
  };
  return { exec, calls };
}

it("supports staged diffs and paths containing spaces", async () => {
  const { exec, calls } = successfulExec("diff --git a/file name.txt b/file name.txt\n");
  const response = await createGitDiffTool(exec).execute(
    "1",
    { staged: true, paths: ["src", "README.md"], maxBytes: 1024 },
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
  expect(response.details.patch).toContain("file name.txt");
  expect(response.details.output).toEqual({
    truncated: false,
    totalBytes: Buffer.byteLength("diff --git a/file name.txt b/file name.txt\n"),
    totalLines: 1,
  });
});

it("rejects ambiguous path arguments and bounds output", async () => {
  const { exec } = successfulExec("unused");
  await expect(
    createGitDiffTool(exec).execute(
      "1",
      { path: "src", paths: ["README.md"], maxBytes: 10 },
      undefined,
      undefined,
      context,
    ),
  ).rejects.toThrow(/either path or paths/iu);

  const long = successfulExec("0123456789abcdef");
  const response = await createGitDiffTool(long.exec).execute(
    "1",
    { maxBytes: 5 },
    undefined,
    undefined,
    context,
  );
  expect(response.details.patch).toBe("01234");
  expect(response.details.output).toEqual({ truncated: true, totalBytes: 16, totalLines: 1 });
});

it("returns empty and binary-safe representations", async () => {
  const empty = successfulExec("");
  const emptyResponse = await createGitDiffTool(empty.exec).execute(
    "1",
    { maxBytes: 100 },
    undefined,
    undefined,
    context,
  );
  expect(emptyResponse.details).toEqual({
    patch: "",
    output: { truncated: false, totalBytes: 0, totalLines: 0 },
  });

  const binary = successfulExec("Binary files a/x and b/x differ\n");
  const binaryResponse = await createGitDiffTool(binary.exec).execute(
    "1",
    { maxBytes: 100 },
    undefined,
    undefined,
    context,
  );
  expect(binaryResponse.details.patch).toContain("Binary files");
});
