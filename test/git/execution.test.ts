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
import { createGitIntegrationFixtures, gitIntegration } from "./integration-fixtures.ts";

function waitForPid(pidPath: string, attempt = 0): Promise<number> {
  return readFile(pidPath, "utf8")
    .then((value) => Number(value))
    .catch((error: unknown) => {
      if (attempt >= 100) throw error;
      return new Promise<number>((resolve) => setTimeout(resolve, 5)).then(() =>
        waitForPid(pidPath, attempt + 1),
      );
    });
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}

function waitForProcessGone(pid: number, attempt = 0): Promise<boolean> {
  if (processIsGone(pid)) return Promise.resolve(true);
  if (attempt >= 100) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => setTimeout(resolve, 5)).then(() =>
    waitForProcessGone(pid, attempt + 1),
  );
}

const STILL_PENDING = "still-pending";

interface ParkedChildPaths {
  readonly pidPath: string;
  readonly terminatePath: string;
  readonly exitPath: string;
  readonly beforePark?: string;
}

// Child harness used by the ordering tests: it publishes its pid, records the SIGTERM that
// proves the parent issued its termination request, and parks until released by SIGUSR1 so
// the child can only exit from the release, never from the escalation SIGKILL.
function parkedChildSource(paths: ParkedChildPaths): string {
  return [
    "const fs = require('node:fs');",
    "process.stdout.on('error', () => {});",
    "process.stderr.on('error', () => {});",
    `fs.writeFileSync(${JSON.stringify(paths.pidPath)}, String(process.pid));`,
    `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(paths.terminatePath)}, 'terminated'); });`,
    `process.on('SIGUSR1', () => { fs.writeFileSync(${JSON.stringify(paths.exitPath)}, 'released'); process.exit(0); });`,
    paths.beforePark ?? "",
    "setInterval(() => {}, 1000);",
  ].join(" ");
}

function waitForFile(path: string, attempt = 0): Promise<string> {
  return readFile(path, "utf8").catch((error: unknown) => {
    if (attempt >= 400) throw error;
    return new Promise<string>((resolve) => setTimeout(resolve, 2)).then(() =>
      waitForFile(path, attempt + 1),
    );
  });
}

// Discriminating check for the close-ordering claim: the promise must still be pending once
// the termination request has been delivered. An implementation that rejected at request time
// resolves the race to "settled" here and fails this helper.
async function expectStillPending(pending: Promise<unknown>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const outcome = await Promise.race([
    pending.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise<typeof STILL_PENDING>((resolve) => setTimeout(() => resolve(STILL_PENDING), 0)),
  ]);
  if (outcome !== STILL_PENDING) {
    throw new Error("boundedGitExec settled before the child emitted close");
  }
}

// The SIGUSR1 release has to land inside the production CHILD_TERMINATION_GRACE_MS (100 ms)
// window. When an event-loop stall exhausts that window the escalation SIGKILL kills the child
// first, so the release can never work: report that cause instead of a bare ESRCH or a missing
// "released" marker. Kept synchronous so it adds no event-loop delay to the release path.
function releaseParkedChild(pid: number): void {
  const escalationWon = new Error(
    `child ${pid} was already killed when the SIGUSR1 release was attempted: the ` +
      "CHILD_TERMINATION_GRACE_MS (100 ms) escalation window was exhausted by an event-loop " +
      "stall in the test harness, not by a change in termination ordering",
  );
  if (processIsGone(pid)) {
    throw escalationWon;
  }
  try {
    process.kill(pid, "SIGUSR1");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      throw escalationWon;
    }
    throw error;
  }
}

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
