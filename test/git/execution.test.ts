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
    try {
      validateRevision("HEAD:secret.txt");
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toMatchObject({
        contract: {
          code: "invalid-request",
          category: "INVALID_REQUEST",
          invalidField: "revision",
          retryable: false,
          executed: false,
        },
        details: { category: "INVALID_REQUEST", executed: false },
      });
    }
  });

  it("classifies executor failures, nonzero results, and cancellation attempts", async () => {
    await expect(
      runGit(
        async () => {
          throw new Error("spawn failed");
        },
        ["status"],
        process.cwd(),
        undefined,
        "read status",
      ),
    ).rejects.toMatchObject({
      contract: {
        code: "spawn-failure",
        category: "SPAWN_FAILURE",
        retryable: true,
        executed: true,
      },
    });

    await expect(
      runGit(
        async () => ({ stdout: "", stderr: "fatal: failed", code: 128, killed: false }),
        ["status"],
        process.cwd(),
        undefined,
        "read status",
      ),
    ).rejects.toMatchObject({
      contract: {
        code: "git-command-failure",
        category: "IMPLEMENTATION_FAILURE",
        retryable: true,
        executed: true,
      },
    });

    const before = new AbortController();
    before.abort();
    let calls = 0;
    await expect(
      runGit(
        async () => {
          calls += 1;
          return { stdout: "", stderr: "", code: 0, killed: false };
        },
        ["status"],
        process.cwd(),
        before.signal,
        "read status",
      ),
    ).rejects.toMatchObject({
      contract: { code: "cancelled", category: "CANCELLED", retryable: true, executed: false },
    });
    expect(calls).toBe(0);

    const after = new AbortController();
    let release!: () => void;
    const pending = runGit(
      async () =>
        new Promise((resolve) => {
          release = () => resolve({ stdout: "", stderr: "", code: 0, killed: false });
        }),
      ["status"],
      process.cwd(),
      after.signal,
      "read status",
    );
    after.abort();
    release();
    await expect(pending).rejects.toMatchObject({
      contract: { code: "cancelled", category: "CANCELLED", retryable: true, executed: true },
    });
  });
});
