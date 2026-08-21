import { describe, expect, it } from "vitest";
import { runGit, validateRevision } from "../../src/tools/git/execution.ts";

describe("Git execution helpers", () => {
  it("prepends the fixed read-only safety prefix to every Git invocation", async () => {
    let invocation: readonly string[] = [];
    await runGit(
      async (_command, args) => {
        invocation = args;
        return { stdout: "ok", stderr: "", code: 0, killed: false };
      },
      ["status", "--porcelain=v1"],
      process.cwd(),
      undefined,
      "read status",
    );
    expect(invocation).toEqual([
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "status",
      "--porcelain=v1",
    ]);
  });

  it("allows ordinary revisions and rejects option and blob expressions", () => {
    expect(validateRevision("HEAD~2")).toBe("HEAD~2");
    expect(validateRevision("main..feature")).toBe("main..feature");
    expect(() => validateRevision("--help")).toThrow(/safe Git revision/iu);
    expect(() => validateRevision("HEAD:secret.txt")).toThrow(/safe Git revision/iu);
    expect(() => validateRevision("HEAD;echo")).toThrow(/safe Git revision/iu);
  });
});
