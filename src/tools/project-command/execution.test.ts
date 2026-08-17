import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createProjectCommandExecutor, type ProjectCommandSpawn } from "./execution.ts";
import { getProjectCommandDefinition } from "./definitions.ts";

function definition(
  overrides: Partial<NonNullable<ReturnType<typeof getProjectCommandDefinition>>> = {},
) {
  const base = getProjectCommandDefinition("workspace_path");
  if (base === undefined) {
    throw new Error("missing test definition");
  }
  return { ...base, ...overrides };
}

function childProcess(
  closeCode: number | null,
  closeSignal: NodeJS.Signals | null,
  onKill?: (signal: NodeJS.Signals) => void,
) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal: NodeJS.Signals) => boolean;
  };
  child.pid = 1234;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    onKill?.(signal);
    if (signal === "SIGTERM" || signal === "SIGKILL") {
      setImmediate(() => child.emit("close", closeCode, closeSignal ?? signal));
    }
    return true;
  };
  return child;
}

describe("project command execution", () => {
  it("spawns fixed arguments with shell disabled, canonical cwd, static env, and bounded output", async () => {
    let received:
      | { executable: string; args: readonly string[]; options: Parameters<ProjectCommandSpawn>[2] }
      | undefined;
    const spawnCommand: ProjectCommandSpawn = (executable, args, options) => {
      received = { executable, args, options };
      const child = childProcess(0, null);
      setImmediate(() => {
        child.stdout.end("123456789");
        child.stderr.end("warning\n");
        child.emit("close", 0, null);
      });
      return child as unknown as ReturnType<ProjectCommandSpawn>;
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

  it("reports nonzero and spawn failures without raw errors", async () => {
    const nonzero = await createProjectCommandExecutor({
      spawn: ((_, __, ___) => {
        const child = childProcess(7, "SIGTERM");
        setImmediate(() => child.emit("close", 7, "SIGTERM"));
        return child as unknown as ReturnType<ProjectCommandSpawn>;
      }) satisfies ProjectCommandSpawn,
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

  it("handles asynchronous startup errors without an unhandled child error", async () => {
    const child = childProcess(null, null);
    (child as unknown as { pid: number | undefined }).pid = undefined;
    (child as unknown as { once: unknown }).once = undefined;
    const unhandledErrors: unknown[] = [];
    const onUncaughtException = (error: unknown): void => {
      unhandledErrors.push(error);
    };
    process.on("uncaughtException", onUncaughtException);
    let actualResult;
    let result;
    try {
      actualResult = await createProjectCommandExecutor({ processTimeoutMs: 100 })(
        definition({ executable: "/definitely/not/a/project-command" }),
        process.cwd(),
      );
      result = await createProjectCommandExecutor({
        spawn: (() => {
          setImmediate(() => {
            child.emit("error", new Error("secret startup failure"));
            child.emit("close", null, null);
          });
          return child as unknown as ReturnType<ProjectCommandSpawn>;
        }) satisfies ProjectCommandSpawn,
      })(definition(), "/project");
    } finally {
      process.off("uncaughtException", onUncaughtException);
    }
    expect(actualResult.status).toBe("spawn-failure");
    expect(result.status).toBe("spawn-failure");
    expect(unhandledErrors).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("secret startup failure");
  });

  it("terminates and awaits a child when output cleanup is unsupported", async () => {
    const signals: NodeJS.Signals[] = [];
    const child = childProcess(null, null, (signal) => signals.push(signal));
    let closeObserved = false;
    child.on("close", () => {
      closeObserved = true;
    });
    (child as unknown as { stdout: PassThrough | null }).stdout = null;
    const result = await createProjectCommandExecutor({
      platform: "linux",
      spawn: (() =>
        child as unknown as ReturnType<ProjectCommandSpawn>) satisfies ProjectCommandSpawn,
    })(definition(), "/project");
    expect(result.status).toBe("cleanup-failure");
    expect(signals).toEqual(["SIGTERM"]);
    expect(closeObserved).toBe(true);
  });

  it("waits for a child to close after kill reports failure", async () => {
    const signals: NodeJS.Signals[] = [];
    const child = childProcess(null, null);
    child.kill = (signal) => {
      signals.push(signal);
      if (signal === "SIGTERM") {
        setTimeout(() => child.emit("close", null, "SIGTERM"), 30);
      }
      return false;
    };
    let returned = false;
    const resultPromise = createProjectCommandExecutor({
      platform: "linux",
      processTimeoutMs: 1,
      killGraceMs: 5,
      spawn: (() =>
        child as unknown as ReturnType<ProjectCommandSpawn>) satisfies ProjectCommandSpawn,
    })(definition(), "/project");
    void resultPromise.then(() => {
      returned = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(returned).toBe(false);
    const result = await resultPromise;
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result.status).toBe("cleanup-failure");
  });

  it("waits for close after a non-ESRCH signal failure", async () => {
    const signals: NodeJS.Signals[] = [];
    const child = childProcess(null, null);
    child.kill = (signal) => {
      signals.push(signal);
      if (signal === "SIGTERM") {
        throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      }
      setTimeout(() => child.emit("close", null, "SIGKILL"), 30);
      return true;
    };
    const unhandledErrors: unknown[] = [];
    const onUncaughtException = (error: unknown): void => {
      unhandledErrors.push(error);
    };
    process.on("uncaughtException", onUncaughtException);
    let returned = false;
    let resultPromise: ReturnType<ReturnType<typeof createProjectCommandExecutor>>;
    try {
      resultPromise = createProjectCommandExecutor({
        platform: "linux",
        processTimeoutMs: 1,
        killGraceMs: 5,
        spawn: (() =>
          child as unknown as ReturnType<ProjectCommandSpawn>) satisfies ProjectCommandSpawn,
      })(definition(), "/project");
      void resultPromise.then(() => {
        returned = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(returned).toBe(false);
      const result = await resultPromise;
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(result.status).toBe("cleanup-failure");
    } finally {
      process.off("uncaughtException", onUncaughtException);
    }
    expect(unhandledErrors).toEqual([]);
  });

  it("waits for an unsupported no-PID child to close after a startup error", async () => {
    const child = childProcess(null, null);
    (child as unknown as { pid: number | undefined }).pid = undefined;
    let closeObserved = false;
    child.on("close", () => {
      closeObserved = true;
    });
    const unhandledErrors: unknown[] = [];
    const onUncaughtException = (error: unknown): void => {
      unhandledErrors.push(error);
    };
    process.on("uncaughtException", onUncaughtException);
    let returned = false;
    let resultPromise: ReturnType<ReturnType<typeof createProjectCommandExecutor>>;
    try {
      resultPromise = createProjectCommandExecutor({
        processTimeoutMs: 100,
        spawn: (() => {
          setImmediate(() => {
            child.emit("error", new Error("secret startup failure"));
            setTimeout(() => child.emit("close", null, null), 30);
          });
          return child as unknown as ReturnType<ProjectCommandSpawn>;
        }) satisfies ProjectCommandSpawn,
      })(definition(), "/project");
      void resultPromise.then(() => {
        returned = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(returned).toBe(false);
      const result = await resultPromise;
      expect(result.status).toBe("spawn-failure");
    } finally {
      process.off("uncaughtException", onUncaughtException);
    }
    expect(closeObserved).toBe(true);
    expect(unhandledErrors).toEqual([]);
  });

  it("terminates on timeout and cancellation with the configured cleanup signals", async () => {
    const signals: NodeJS.Signals[] = [];
    const timeout = await createProjectCommandExecutor({
      platform: "linux",
      processTimeoutMs: 1,
      killGraceMs: 20,
      spawn: (() => {
        const child = childProcess(null, null, (signal) => signals.push(signal));
        return child as unknown as ReturnType<ProjectCommandSpawn>;
      }) satisfies ProjectCommandSpawn,
    })(definition(), "/project");
    expect(timeout.status).toBe("timeout");
    expect(timeout.timedOut).toBe(true);
    expect(signals).toEqual(["SIGTERM"]);

    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const cancellation = createProjectCommandExecutor({
      platform: "linux",
      killGraceMs: 20,
      spawn: ((_, __, options) => {
        receivedSignal = options.signal;
        const child = childProcess(null, null);
        setTimeout(() => controller.abort(), 1);
        return child as unknown as ReturnType<ProjectCommandSpawn>;
      }) satisfies ProjectCommandSpawn,
    })(definition(), "/project", controller.signal);
    const cancelled = await cancellation;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelled).toBe(true);
    expect(receivedSignal).toBe(controller.signal);
  });

  it("fails closed after observing close when process cleanup cannot be supported", async () => {
    const child = new EventEmitter();
    Object.assign(child, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    let closeObserved = false;
    child.once("close", () => {
      closeObserved = true;
    });
    const outcome = await createProjectCommandExecutor({
      processTimeoutMs: 1,
      spawn: (() => {
        setImmediate(() => child.emit("close", 0, null));
        return child as unknown as ReturnType<ProjectCommandSpawn>;
      }) satisfies ProjectCommandSpawn,
    })(definition(), "/project");
    expect(outcome.status).toBe("cleanup-failure");
    expect(closeObserved).toBe(true);
  });

  it("uses Darwin process-group cleanup for detached children and captures pipe output", async () => {
    const signals: Array<{ pid: number; signal: string | number }> = [];
    const child = childProcess(null, null);
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
          return child as unknown as ReturnType<ProjectCommandSpawn>;
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
});
