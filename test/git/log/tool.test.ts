import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";

import type { GitExec } from "../../../src/tools/git/execution.ts";
import { gitLogOutputSchema } from "../../../src/tools/git/log/output.ts";
import { createGitLogTool } from "../../../src/tools/git/log/tool.ts";
import type { GitToolContext } from "../../../src/tools/git/tool.ts";

const cwd = process.cwd();
const context: GitToolContext = { cwd, signal: undefined };
const result = (stdout = "", stderr = "", code = 0) => ({ stdout, stderr, code, killed: false });

function logExec(stdout: string): { exec: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: GitExec = async (_command, args) => {
    calls.push([...args]);
    return args[3] === "rev-parse" ? result(`${cwd}\n`) : result(stdout);
  };
  return { exec, calls };
}

describe("git_log tool", () => {
  it("parses authors, strict dates, subjects, revisions, and paths", async () => {
    const output =
      "a1\0Alice Example\x002024-01-01T00:00:00Z\0first commit\0a2\0Bob\x002024-01-02T00:00:00Z\0second commit\0";
    const { exec, calls } = logExec(output);
    const response = await createGitLogTool(exec).execute(
      "1",
      { revision: "HEAD~2", path: "src", maxEntries: 2 },
      undefined,
      undefined,
      context,
    );
    expect(calls[1]).toEqual([
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "log",
      "--no-ext-diff",
      "--no-textconv",
      "--no-decorate",
      "--date=iso-strict",
      "--format=format:%H%x00%an%x00%aI%x00%s%x00",
      "--max-count=2",
      "HEAD~2",
      "--",
      "src",
    ]);
    expect(response.details.entries).toEqual([
      { id: "a1", author: "Alice Example", date: "2024-01-01T00:00:00Z", subject: "first commit" },
      { id: "a2", author: "Bob", date: "2024-01-02T00:00:00Z", subject: "second commit" },
    ]);
    expect(response.details.output.truncated).toBe(false);
  });

  it("returns schema-conforming structuredContent with unchanged model-facing content", async () => {
    const output = "a1\0Alice Example\x002024-01-01T00:00:00Z\0first commit\0";
    const { exec } = logExec(output);
    const tool = createGitLogTool(exec);
    expect(tool.outputSchema).toBe(gitLogOutputSchema);
    const response = await tool.execute(
      "structured",
      { revision: "HEAD", maxEntries: 1 },
      undefined,
      undefined,
      context,
    );
    expect(response.structuredContent).toEqual(response.details);
    expect(Check(gitLogOutputSchema, response.structuredContent)).toBe(true);
    expect(response.content).toEqual([{ type: "text", text: JSON.stringify(response.details) }]);
  });

  it("rejects unsafe revisions and propagates invalid revision errors", async () => {
    const { exec } = logExec("");
    await expect(
      createGitLogTool(exec).execute(
        "1",
        { revision: "HEAD:secret", maxEntries: 1 },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow(/safe Git revision/iu);

    const invalid: GitExec = async (_command, args) =>
      args[3] === "rev-parse" ? result(`${cwd}\n`) : result("", "bad revision", 128);
    await expect(
      createGitLogTool(invalid).execute(
        "1",
        { revision: "does-not-exist", maxEntries: 1 },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow(/bad revision/iu);
  });
});
