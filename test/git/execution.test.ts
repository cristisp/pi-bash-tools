import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  boundedGitExec,
  GitOutputLimitError,
  runGit,
  validateRevision,
  type GitExec,
} from "../../src/tools/git/execution.ts";
import {
  expectStillPending,
  parkedChildSource,
  releaseParkedChild,
  waitForFile,
  waitForPid,
  waitForProcessGone,
} from "./execution-test-helpers.ts";
import { createGitIntegrationFixtures, gitIntegration } from "./integration-fixtures.ts";

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

  it("waits for bounded-output child cleanup before rejecting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bash-tools-git-exec-"));
    const pidPath = join(directory, "pid");
    const terminatePath = join(directory, "terminated");
    const exitPath = join(directory, "exited");
    const pending = boundedGitExec(
      process.execPath,
      [
        "-e",
        parkedChildSource({
          pidPath,
          terminatePath,
          exitPath,
          beforePark: "process.stdout.write('x'.repeat(1024 * 1024));",
        }),
      ],
      { cwd: process.cwd() },
      1024,
    );
    try {
      const pid = await waitForPid(pidPath);
      // The recorded SIGTERM proves the overflow termination request was already issued.
      expect(await waitForFile(terminatePath)).toBe("terminated");
      await expectStillPending(pending);
      releaseParkedChild(pid);
      await expect(pending).rejects.toThrow("Git output exceeded the configured limit");
      // The child exited from the release rather than the escalation SIGKILL, and is gone.
      expect(await readFile(exitPath, "utf8")).toBe("released");
      expect(await waitForProcessGone(pid)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("escalates bounded-output termination when a child ignores SIGTERM", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bash-tools-git-exec-"));
    const pidPath = join(directory, "pid");
    try {
      await expect(
        boundedGitExec(
          process.execPath,
          [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.on('SIGTERM',()=>{}); process.stdout.write('x'.repeat(1024 * 1024)); setInterval(()=>{},1000)`,
          ],
          { cwd: process.cwd() },
          1024,
        ),
      ).rejects.toThrow("output exceeded");
      const pid = await waitForPid(pidPath);
      expect(await waitForProcessGone(pid)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("waits for cancellation cleanup before rejecting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bash-tools-git-exec-"));
    const pidPath = join(directory, "pid");
    const terminatePath = join(directory, "terminated");
    const exitPath = join(directory, "exited");
    const controller = new AbortController();
    const pending = boundedGitExec(
      process.execPath,
      ["-e", parkedChildSource({ pidPath, terminatePath, exitPath })],
      { cwd: process.cwd(), signal: controller.signal },
      1024,
    );
    try {
      const pid = await waitForPid(pidPath);
      // abort() runs the listener synchronously, so the cancellation request is already issued.
      controller.abort();
      expect(await waitForFile(terminatePath)).toBe("terminated");
      await expectStillPending(pending);
      releaseParkedChild(pid);
      await expect(pending).rejects.toThrow("Git command cancelled");
      expect(await readFile(exitPath, "utf8")).toBe("released");
      expect(await waitForProcessGone(pid)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // F-013: an output-limit breach must never surface as a spawn failure, whichever layer
  // detects it. Both producers have to converge on one stable contract.
  it("reports a branded output-limit breach as the output-limit contract", async () => {
    await expect(
      runGit(
        async () => {
          throw new GitOutputLimitError(4096);
        },
        ["status"],
        process.cwd(),
        undefined,
        "read status",
        4096,
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("output limit"),
      contract: {
        code: "git-output-limit-exceeded",
        category: "IMPLEMENTATION_FAILURE",
        explanation: "The Git command output exceeded the configured limit.",
        retryable: false,
        executed: true,
      },
    });
  });

  it("reports a post-execution byte-length breach with the same output-limit contract", async () => {
    await expect(
      runGit(
        async () => ({ stdout: "x".repeat(2048), stderr: "", code: 0, killed: false }),
        ["status"],
        process.cwd(),
        undefined,
        "read status",
        1024,
      ),
    ).rejects.toMatchObject({
      contract: {
        code: "git-output-limit-exceeded",
        category: "IMPLEMENTATION_FAILURE",
        explanation: "The Git command output exceeded the configured limit.",
        retryable: false,
        executed: true,
      },
    });
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

// End to end through the real bounded executor in a real repository: the overflow is detected
// while the child is still running, so runGit() must classify it as an output-limit breach.
function boundedExecWith(maxOutputBytes: number): GitExec {
  return (command, args, options) =>
    boundedGitExec(command, args, { ...options, maxOutputBytes }, maxOutputBytes);
}

gitIntegration("Git output limit end to end", () => {
  it("reports a real bounded-executor output breach as the output-limit contract", async () => {
    const fixtures = createGitIntegrationFixtures();
    const { directory } = await fixtures.createRepository();
    try {
      await expect(
        runGit(
          boundedExecWith(16),
          ["rev-parse", "HEAD"],
          directory,
          undefined,
          "repository HEAD",
          16,
        ),
      ).rejects.toMatchObject({
        contract: {
          code: "git-output-limit-exceeded",
          category: "IMPLEMENTATION_FAILURE",
          explanation: "The Git command output exceeded the configured limit.",
          retryable: false,
          executed: true,
        },
      });
    } finally {
      await fixtures.cleanup();
    }
  });
});
