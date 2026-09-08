import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import { expect, it, vi } from "vitest";

import { getProjectCommandDefinition } from "../../src/tools/project-command/definitions.ts";
import {
  createProjectCommandExecutor,
  type ProjectCommandSpawn,
} from "../../src/tools/project-command/execution.ts";

function definition(
  overrides: Partial<NonNullable<ReturnType<typeof getProjectCommandDefinition>>> = {},
) {
  const base = getProjectCommandDefinition("workspace_path");
  if (base === undefined) {
    throw new Error("missing test definition");
  }
  return { ...base, ...overrides };
}

class FakeChild extends ChildProcess {
  declare pid: number;
  declare stdout: PassThrough;
  declare stderr: PassThrough;

  constructor(private readonly onKill?: (child: FakeChild, signal: NodeJS.Signals) => void) {
    super();
    this.pid = 1234;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  override kill(signal?: NodeJS.Signals | number): boolean {
    if (typeof signal === "string") {
      this.onKill?.(this, signal);
    }
    return true;
  }
}

function childProcess(onKill?: (child: FakeChild, signal: NodeJS.Signals) => void): FakeChild {
  return new FakeChild(onKill);
}

function spawnWith(child: FakeChild, setup?: () => void): ProjectCommandSpawn {
  return (() => {
    if (setup !== undefined) {
      setImmediate(setup);
    }
    return child;
  }) satisfies ProjectCommandSpawn;
}

it("spawns fixed arguments with shell disabled, canonical cwd, static env, and bounded output", async () => {
  let received:
    | { executable: string; args: readonly string[]; options: Parameters<ProjectCommandSpawn>[2] }
    | undefined;
  const spawnCommand: ProjectCommandSpawn = (executable, args, options) => {
    received = { executable, args, options };
    const child = childProcess();
    setImmediate(() => {
      child.stdout.write("123456789");
      child.stderr.write("warning\n");
      child.emit("close", 0, null);
    });
    return child;
  };
  const result = await createProjectCommandExecutor({ spawn: spawnCommand })(
    definition({ outputLimitBytes: 4 }),
    "/canonical/project",
  );
  expect(received).toMatchObject({
    executable: "/bin/pwd",
    args: [],
    options: {
      cwd: "/canonical/project",
      shell: false,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  });
  expect(received?.options.signal).toBeUndefined();
  expect(result).toMatchObject({
    status: "success",
    exit: { code: 0, signal: null },
    stdout: { text: "1234", truncated: true, totalBytes: 9 },
    stderr: { text: "warn", truncated: true, totalBytes: 8, totalLines: 1 },
  });
  expect(JSON.stringify(result)).not.toContain("/canonical/project");
});

it("executes in-process details without spawning a child", async () => {
  const spawnCommand = vi.fn<ProjectCommandSpawn>();
  const nodeInfoDefinition = getProjectCommandDefinition("node_project_info");
  if (nodeInfoDefinition === undefined) throw new Error("missing node_project_info definition");
  const result = await createProjectCommandExecutor({ spawn: spawnCommand })(
    nodeInfoDefinition,
    "/project",
  );
  expect(result).toMatchObject({ status: "success", stdout: { text: "" } });
  expect(spawnCommand).not.toHaveBeenCalled();
});

it("counts CR, LF, CRLF, chunk boundaries, and partial lines", async () => {
  const child = childProcess();
  const resultPromise = createProjectCommandExecutor({
    spawn: spawnWith(child, () => {
      setImmediate(() => {
        child.stdout.write("one\r");
        child.stdout.write("\ntwo\nthree\r");
        child.stdout.write("\nfour");
        child.emit("close", 0, null);
      });
    }),
  })(definition(), "/project");
  const result = await resultPromise;
  expect(result.stdout).toMatchObject({
    text: "one\r\ntwo\nthree\r\nfour",
    totalBytes: 20,
    totalLines: 4,
    truncated: false,
  });
});

it("keeps the tail of project-code output while preserving UTF-8", async () => {
  const child = childProcess();
  const result = await createProjectCommandExecutor({
    spawn: spawnWith(child, () =>
      setImmediate(() => {
        child.stdout.write("prefix-😀-suffix");
        child.emit("close", 0, null);
      }),
    ),
  })(definition({ truncationDirection: "tail", outputLimitBytes: 8 }), "/project");
  expect(result.stdout).toMatchObject({
    text: "-suffix",
    truncated: true,
    totalBytes: Buffer.byteLength("prefix-😀-suffix"),
  });
});

it("reports nonzero and synchronous spawn failures without raw errors", async () => {
  const child = childProcess();
  const nonzero = await createProjectCommandExecutor({
    spawn: spawnWith(child, () => setImmediate(() => child.emit("close", 7, "SIGTERM"))),
  })(definition(), "/project");
  expect(nonzero).toMatchObject({ status: "nonzero", exit: { code: 7, signal: "SIGTERM" } });

  const spawnFailure = await createProjectCommandExecutor({
    spawn: (() => {
      throw new Error("secret executable path");
    }) satisfies ProjectCommandSpawn,
  })(definition(), "/project");
  expect(spawnFailure.status).toBe("spawn-failure");
  expect(JSON.stringify(spawnFailure)).not.toContain("secret executable path");
});

it("handles an asynchronous startup error and close without an unhandled error", async () => {
  const child = childProcess((current, signal) => {
    if (signal === "SIGTERM") {
      setImmediate(() => current.emit("close", null, "SIGTERM"));
    }
  });
  const unhandledErrors: unknown[] = [];
  const onUncaughtException = (error: unknown): void => {
    unhandledErrors.push(error);
  };
  process.on("uncaughtException", onUncaughtException);
  let result;
  try {
    result = await createProjectCommandExecutor({
      platform: "linux",
      spawn: spawnWith(child, () =>
        setImmediate(() => child.emit("error", new Error("secret startup failure"))),
      ),
    })(definition(), "/project");
  } finally {
    process.off("uncaughtException", onUncaughtException);
  }
  expect(result.status).toBe("spawn-failure");
  expect(unhandledErrors).toEqual([]);
  expect(JSON.stringify(result)).not.toContain("secret startup failure");
});

it("escalates from SIGTERM to SIGKILL after the grace period and waits for close", async () => {
  const signals: NodeJS.Signals[] = [];
  const child = childProcess((current, signal) => {
    signals.push(signal);
    if (signal === "SIGKILL") {
      setImmediate(() => current.emit("close", null, "SIGKILL"));
    }
  });
  const result = await createProjectCommandExecutor({
    platform: "linux",
    processTimeoutMs: 1,
    killGraceMs: 5,
    spawn: spawnWith(child),
  })(definition(), "/project");
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(result).toMatchObject({ status: "timeout", timedOut: true });
});

it("passes cancellation through to spawn and terminates the child", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const signals: NodeJS.Signals[] = [];
  const child = childProcess((current, signal) => {
    signals.push(signal);
    setImmediate(() => current.emit("close", null, signal));
  });
  const resultPromise = createProjectCommandExecutor({
    platform: "linux",
    killGraceMs: 20,
    spawn: ((_, __, options) => {
      receivedSignal = options.signal;
      setTimeout(() => controller.abort(), 1);
      return child;
    }) satisfies ProjectCommandSpawn,
  })(definition(), "/project", controller.signal);
  const result = await resultPromise;
  expect(receivedSignal).toBe(controller.signal);
  expect(signals).toEqual(["SIGTERM"]);
  expect(result).toMatchObject({ status: "cancelled", cancelled: true });
});

it("uses Darwin process-group cleanup and captures descendant output", async () => {
  const signals: Array<{ pid: number; signal: string | number }> = [];
  const child = childProcess();
  const processKill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    signals.push({ pid, signal: signal ?? 0 });
    if (signal === "SIGKILL") {
      child.stdout.write("descendant output\n");
      child.stderr.write("descendant warning\n");
      setImmediate(() => child.emit("close", null, "SIGKILL"));
    }
    return true;
  });
  let receivedOptions: Parameters<ProjectCommandSpawn>[2] | undefined;
  let result;
  try {
    result = await createProjectCommandExecutor({
      platform: "darwin",
      processTimeoutMs: 1,
      killGraceMs: 10,
      spawn: ((_, __, options) => {
        receivedOptions = options;
        return child;
      }) satisfies ProjectCommandSpawn,
    })(definition(), "/project");
  } finally {
    processKill.mockRestore();
  }
  expect(receivedOptions).toMatchObject({ detached: true, stdio: ["ignore", "pipe", "pipe"] });
  expect(signals).toEqual([
    { pid: -1234, signal: "SIGTERM" },
    { pid: -1234, signal: "SIGKILL" },
  ]);
  expect(result).toMatchObject({
    status: "timeout",
    exit: { code: null, signal: "SIGKILL" },
    stdout: { text: "descendant output\n" },
    stderr: { text: "descendant warning\n" },
  });
});

it("tolerates an already exited child during cleanup", async () => {
  const child = childProcess((current) => {
    setImmediate(() => current.emit("close", null, "SIGTERM"));
    throw Object.assign(new Error("already gone"), { code: "ESRCH" });
  });
  const result = await createProjectCommandExecutor({
    platform: "linux",
    processTimeoutMs: 1,
    spawn: spawnWith(child),
  })(definition(), "/project");
  expect(result.status).toBe("timeout");
});
