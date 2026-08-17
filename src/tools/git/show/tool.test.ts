import { describe, expect, it } from "vitest";
import { createGitShowTool } from "./tool.ts";
import type { GitExec } from "../execution.ts";
import type { GitToolContext } from "../tool.ts";

const cwd = process.cwd();
const context: GitToolContext = { cwd, signal: undefined };
const result = (stdout = "", stderr = "", code = 0) => ({ stdout, stderr, code, killed: false });

function showExec(stdout: string): { exec: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: GitExec = async (_command, args) => {
    calls.push([...args]);
    return args[3] === "rev-parse" ? result(`${cwd}\n`) : result(stdout);
  };
  return { exec, calls };
}

describe("git_show tool", () => {
  it("uses revision and path as separate arguments", async () => {
    const { exec, calls } = showExec("commit output\n");
    const response = await createGitShowTool(exec).execute(
      "1",
      { revision: "HEAD~1", path: "file with spaces.txt", maxBytes: 100 },
      undefined,
      undefined,
      context,
    );
    expect(calls[1]).toEqual([
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "show",
      "--no-ext-diff",
      "--no-textconv",
      "HEAD~1",
      "--",
      "file with spaces.txt",
    ]);
    expect(response.details).toEqual({
      content: "commit output\n",
      output: { truncated: false, totalBytes: 14, totalLines: 1 },
    });
  });

  it("rejects REV:path extraction and invalid revisions", async () => {
    const { exec } = showExec("");
    await expect(
      createGitShowTool(exec).execute(
        "1",
        { revision: "HEAD:file.txt", maxBytes: 10 },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow(/safe Git revision/iu);

    const invalid = showExec("");
    invalid.exec = async (_command, args) =>
      args[3] === "rev-parse" ? result(`${cwd}\n`) : result("", "unknown revision", 128);
    await expect(
      createGitShowTool(invalid.exec).execute(
        "1",
        { revision: "missing", maxBytes: 10 },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow(/unknown revision/iu);
  });

  it("bounds empty and binary output", async () => {
    const empty = showExec("");
    const emptyResponse = await createGitShowTool(empty.exec).execute(
      "1",
      { revision: "HEAD", maxBytes: 1 },
      undefined,
      undefined,
      context,
    );
    expect(emptyResponse.details.output).toEqual({
      truncated: false,
      totalBytes: 0,
      totalLines: 0,
    });

    const binary = showExec("\ufffd\u0000\ufffd");
    const binaryResponse = await createGitShowTool(binary.exec).execute(
      "1",
      { revision: "HEAD", maxBytes: 2 },
      undefined,
      undefined,
      context,
    );
    expect(binaryResponse.details.output.truncated).toBe(true);
  });
});
