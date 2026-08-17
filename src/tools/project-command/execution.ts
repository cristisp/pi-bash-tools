import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { decodeUtf8Prefix } from "../truncation.ts";
import {
  PROJECT_COMMAND_OUTPUT_LIMIT_BYTES,
  type ProjectCommandDefinition,
} from "./definitions.ts";

export type ProjectCommandExecutionStatus =
  | "success"
  | "nonzero"
  | "timeout"
  | "spawn-failure"
  | "cleanup-failure"
  | "cancelled";

export interface ProjectCommandOutput {
  readonly text: string;
  readonly truncated: boolean;
  readonly totalBytes: number;
  readonly totalLines: number;
}

export interface ProjectCommandExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface ProjectCommandExecutionOutcome {
  readonly status: ProjectCommandExecutionStatus;
  readonly exit: ProjectCommandExit;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly stdout: ProjectCommandOutput;
  readonly stderr: ProjectCommandOutput;
}

export interface ProjectCommandExecutorOptions {
  readonly spawn?: ProjectCommandSpawn;
  readonly platform?: NodeJS.Platform;
  readonly processTimeoutMs?: number;
  readonly killGraceMs?: number;
}

export type ProjectCommandSpawn = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

const STATIC_ENVIRONMENT: NodeJS.ProcessEnv = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
});
const DEFAULT_KILL_GRACE_MS = 150;

class Capture {
  private readonly chunks: Buffer[] = [];
  private retainedBytes = 0;
  private totalBytes = 0;
  private lineBreaks = 0;
  private hasContentSinceLineBreak = false;
  private previousWasCarriageReturn = false;

  constructor(private readonly limit: number) {}

  append(value: Buffer | string): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.totalBytes += chunk.byteLength;
    for (const byte of chunk) {
      if (byte === 0x0d) {
        this.lineBreaks += 1;
        this.hasContentSinceLineBreak = false;
        this.previousWasCarriageReturn = true;
      } else if (byte === 0x0a) {
        if (!this.previousWasCarriageReturn) {
          this.lineBreaks += 1;
        }
        this.hasContentSinceLineBreak = false;
        this.previousWasCarriageReturn = false;
      } else {
        this.hasContentSinceLineBreak = true;
        this.previousWasCarriageReturn = false;
      }
    }
    if (this.retainedBytes >= this.limit) {
      return;
    }
    const retained = chunk.subarray(0, this.limit - this.retainedBytes);
    this.chunks.push(retained);
    this.retainedBytes += retained.byteLength;
  }

  output(): ProjectCommandOutput {
    const bytes = Buffer.concat(this.chunks, this.retainedBytes);
    const truncated = this.totalBytes > this.limit;
    const text = decodeUtf8Prefix(bytes, this.limit, truncated);
    return {
      text,
      truncated,
      totalBytes: this.totalBytes,
      totalLines:
        this.totalBytes === 0 ? 0 : this.lineBreaks + (this.hasContentSinceLineBreak ? 1 : 0),
    };
  }
}

function emptyOutput(): ProjectCommandOutput {
  return { text: "", truncated: false, totalBytes: 0, totalLines: 0 };
}

function emptyOutcome(status: ProjectCommandExecutionStatus): ProjectCommandExecutionOutcome {
  return {
    status,
    exit: { code: null, signal: null },
    timedOut: status === "timeout",
    cancelled: status === "cancelled",
    stdout: emptyOutput(),
    stderr: emptyOutput(),
  };
}

function outcomeWithOutput(
  status: ProjectCommandExecutionStatus,
  stdout: Capture,
  stderr: Capture,
): ProjectCommandExecutionOutcome {
  const empty = emptyOutcome(status);
  return { ...empty, stdout: stdout.output(), stderr: stderr.output() };
}

function isAlreadyExited(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ESRCH"
  );
}

function requirePid(child: ChildProcess): number {
  const pid = child.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    throw new Error("process cleanup is unsupported");
  }
  return pid;
}

function sendSignal(child: ChildProcess, platform: NodeJS.Platform, signal: NodeJS.Signals): void {
  try {
    if (platform === "darwin") {
      if (typeof process.kill !== "function") {
        throw new Error("process cleanup is unsupported");
      }
      process.kill(-requirePid(child), signal);
      return;
    }
    if (typeof child.kill !== "function") {
      throw new Error("process cleanup is unsupported");
    }
    const killResult: unknown = child.kill(signal);
    if (killResult === false) {
      throw new Error("process cleanup is unsupported");
    }
  } catch (error) {
    if (!isAlreadyExited(error)) {
      throw error;
    }
  }
}

type ChildProcessEventListener = (...args: unknown[]) => void;

function addChildEventListener(
  child: ChildProcess,
  event: string,
  listener: ChildProcessEventListener,
): boolean {
  for (const methodName of ["once", "on", "addListener"]) {
    const register = Reflect.get(child, methodName);
    if (typeof register !== "function") {
      continue;
    }
    try {
      Reflect.apply(register, child, [event, listener]);
      return true;
    } catch {
      // Try the next EventEmitter registration method before failing closed.
    }
  }
  return false;
}

function addOutputDataListener(stream: unknown, capture: Capture): boolean {
  if (stream === null || (typeof stream !== "object" && typeof stream !== "function")) {
    return false;
  }
  const register = Reflect.get(stream, "on");
  if (typeof register !== "function") {
    return false;
  }
  try {
    Reflect.apply(register, stream, [
      "data",
      (chunk: unknown) => {
        if (Buffer.isBuffer(chunk) || typeof chunk === "string") {
          capture.append(chunk);
        }
      },
    ]);
    return true;
  } catch {
    return false;
  }
}

function canTerminate(child: ChildProcess, platform: NodeJS.Platform): boolean {
  try {
    requirePid(child);
    return platform === "darwin"
      ? typeof process.kill === "function"
      : typeof child.kill === "function";
  } catch {
    return false;
  }
}

function confirmedChildExit(child: ChildProcess): ProjectCommandExit | undefined {
  let exitCode: unknown;
  let signalCode: unknown;
  try {
    exitCode = Reflect.get(child, "exitCode");
    signalCode = Reflect.get(child, "signalCode");
  } catch {
    return undefined;
  }
  if (typeof exitCode === "number" && exitCode >= 0) {
    return { code: exitCode, signal: null };
  }
  if (typeof signalCode === "string") {
    return { code: null, signal: signalCode };
  }
  return undefined;
}

function childHasExited(child: ChildProcess): boolean {
  return confirmedChildExit(child) !== undefined;
}

function waitForCloseOrExit(
  child: ChildProcess,
  close: Promise<void>,
  onExit: () => void,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve();
    };
    const check = (): void => {
      if (childHasExited(child)) {
        onExit();
        finish();
        return;
      }
      timer = setTimeout(check, 10);
    };
    void close.then(finish);
    check();
  });
}

function waitForCloseOrTimeout(close: Promise<void>, milliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(closed);
    };
    void close.then(() => finish(true));
    setTimeout(() => finish(false), Math.max(0, milliseconds));
  });
}

interface SignalAttempt {
  readonly failed: boolean;
  readonly error: unknown;
}

function attemptSignal(
  child: ChildProcess,
  platform: NodeJS.Platform,
  signal: NodeJS.Signals,
): SignalAttempt {
  try {
    sendSignal(child, platform, signal);
    return { failed: false, error: undefined };
  } catch (error) {
    return { failed: true, error };
  }
}

async function terminateChild(
  child: ChildProcess,
  platform: NodeJS.Platform,
  close: Promise<void>,
  graceMs: number,
  onConfirmedExit: () => void,
): Promise<void> {
  if (!canTerminate(child, platform)) {
    await close;
    throw new Error("process cleanup is unsupported");
  }

  const termination = attemptSignal(child, platform, "SIGTERM");
  if (await waitForCloseOrTimeout(close, graceMs)) {
    if (termination.failed) {
      throw termination.error;
    }
    return;
  }
  if (childHasExited(child)) {
    onConfirmedExit();
    if (termination.failed) {
      throw termination.error;
    }
    return;
  }

  const kill = attemptSignal(child, platform, "SIGKILL");
  await waitForCloseOrExit(child, close, onConfirmedExit);
  if (termination.failed) {
    throw termination.error;
  }
  if (kill.failed) {
    throw kill.error;
  }
}

function spawnProjectCommand(
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  return spawn(executable, [...args], options);
}

export function createProjectCommandExecutor(
  options: ProjectCommandExecutorOptions = {},
): (
  definition: ProjectCommandDefinition,
  cwd: string,
  signal?: AbortSignal,
) => Promise<ProjectCommandExecutionOutcome> {
  const spawnCommand = options.spawn ?? spawnProjectCommand;
  const platform = options.platform ?? process.platform;
  const graceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  return async (definition, cwd, signal) =>
    executeProjectCommand(definition, cwd, signal, {
      spawn: spawnCommand,
      platform,
      processTimeoutMs: options.processTimeoutMs ?? definition.processTimeoutMs,
      killGraceMs: graceMs,
    });
}

interface ProjectCommandRunState {
  exit: ProjectCommandExit;
  spawnFailure: boolean;
  settled: boolean;
  timedOut: boolean;
  cancelled: boolean;
  cleanupFailure: boolean;
}

interface ProjectCommandMonitorSetup {
  readonly closeFinished: Promise<void>;
  readonly terminationStarted: Promise<void>;
  readonly requestTermination: () => Promise<void>;
  readonly getTermination: () => Promise<void> | undefined;
  readonly canCleanUp: boolean;
  readonly cleanupUnsupported: boolean;
}

function createProjectCommandMonitorSetup(
  child: ChildProcess,
  stdout: Capture,
  stderr: Capture,
  platform: NodeJS.Platform,
  killGraceMs: number,
  state: ProjectCommandRunState,
): ProjectCommandMonitorSetup {
  let closeResolve!: () => void;
  const closeFinished = new Promise<void>((resolve) => {
    closeResolve = resolve;
  });
  const markConfirmedExit = (): void => {
    const exit = confirmedChildExit(child);
    if (exit === undefined || state.settled) {
      return;
    }
    state.exit = exit;
    state.settled = true;
    closeResolve();
  };
  const onClose: ChildProcessEventListener = (code, childSignal): void => {
    state.exit = {
      code: typeof code === "number" ? code : null,
      signal: typeof childSignal === "string" ? childSignal : null,
    };
    state.settled = true;
    closeResolve();
  };
  const closeListenerAttached = addChildEventListener(child, "close", onClose);
  const canCleanUp = canTerminate(child, platform);
  if (childHasExited(child)) {
    markConfirmedExit();
  }
  const childCompletion =
    closeListenerAttached && canCleanUp && !state.settled
      ? closeFinished
      : waitForCloseOrExit(child, closeFinished, markConfirmedExit);
  let termination: Promise<void> | undefined;
  let terminationStartedResolve!: () => void;
  const terminationStarted = new Promise<void>((resolve) => {
    terminationStartedResolve = resolve;
  });
  const requestTermination = (): Promise<void> => {
    if (termination === undefined) {
      termination = terminateChild(
        child,
        platform,
        childCompletion,
        killGraceMs,
        markConfirmedExit,
      ).catch(() => {
        if (!state.spawnFailure) {
          state.cleanupFailure = true;
        }
      });
      terminationStartedResolve();
    }
    return termination;
  };
  const onError: ChildProcessEventListener = (): void => {
    state.spawnFailure = true;
    if (!state.settled) {
      void requestTermination();
    }
  };
  const errorListenerAttached = addChildEventListener(child, "error", onError);
  const stdoutListenerAttached = addOutputDataListener(child.stdout, stdout);
  const stderrListenerAttached = addOutputDataListener(child.stderr, stderr);
  const listenersSupported = [
    errorListenerAttached,
    closeListenerAttached,
    stdoutListenerAttached,
    stderrListenerAttached,
  ].every(Boolean);
  const cleanupUnsupported = !listenersSupported || !canCleanUp;
  if (!listenersSupported) {
    state.cleanupFailure = true;
  }
  return {
    closeFinished,
    terminationStarted,
    requestTermination,
    getTermination: () => termination,
    canCleanUp,
    cleanupUnsupported,
  };
}

async function monitorProjectCommand(
  child: ChildProcess,
  stdout: Capture,
  stderr: Capture,
  signal: AbortSignal | undefined,
  platform: NodeJS.Platform,
  processTimeoutMs: number,
  killGraceMs: number,
): Promise<ProjectCommandRunState> {
  const state: ProjectCommandRunState = {
    exit: { code: null, signal: null },
    spawnFailure: false,
    settled: false,
    timedOut: false,
    cancelled: false,
    cleanupFailure: false,
  };
  const setup = createProjectCommandMonitorSetup(
    child,
    stdout,
    stderr,
    platform,
    killGraceMs,
    state,
  );
  const onAbort = (): void => {
    state.cancelled = true;
    void setup.requestTermination();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeoutId = setTimeout(
    () => {
      state.timedOut = true;
      void setup.requestTermination();
    },
    Math.max(0, processTimeoutMs),
  );

  if (signal?.aborted) {
    onAbort();
  }
  if (setup.cleanupUnsupported) {
    void setup.requestTermination();
  }
  await Promise.race([
    setup.closeFinished,
    setup.terminationStarted.then(() => setup.getTermination() ?? Promise.resolve()),
  ]);
  const termination = setup.getTermination();
  if (termination !== undefined) {
    await termination;
  }
  clearTimeout(timeoutId);
  signal?.removeEventListener("abort", onAbort);
  return state;
}

function outcomeFromRunState(
  state: ProjectCommandRunState,
  stdout: Capture,
  stderr: Capture,
): ProjectCommandExecutionOutcome {
  const base = {
    exit: state.exit,
    timedOut: state.timedOut,
    cancelled: state.cancelled,
    stdout: stdout.output(),
    stderr: stderr.output(),
  };
  if (state.cancelled) {
    return { status: "cancelled", ...base };
  }
  if (state.cleanupFailure || !state.settled) {
    return { status: "cleanup-failure", ...base };
  }
  if (state.timedOut) {
    return { status: "timeout", ...base };
  }
  if (state.spawnFailure) {
    return { status: "spawn-failure", ...base };
  }
  return { status: state.exit.code === 0 ? "success" : "nonzero", ...base };
}

async function executeProjectCommand(
  definition: ProjectCommandDefinition,
  cwd: string,
  signal: AbortSignal | undefined,
  options: Required<
    Pick<ProjectCommandExecutorOptions, "spawn" | "platform" | "processTimeoutMs" | "killGraceMs">
  >,
): Promise<ProjectCommandExecutionOutcome> {
  if (signal?.aborted) {
    return emptyOutcome("cancelled");
  }
  const stdout = new Capture(
    Math.min(definition.outputLimitBytes, PROJECT_COMMAND_OUTPUT_LIMIT_BYTES),
  );
  const stderr = new Capture(
    Math.min(definition.outputLimitBytes, PROJECT_COMMAND_OUTPUT_LIMIT_BYTES),
  );
  let child: ChildProcess;
  try {
    child = options.spawn(definition.executable, definition.args, {
      cwd,
      shell: false,
      detached: options.platform === "darwin",
      env: { ...STATIC_ENVIRONMENT },
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
  } catch {
    return outcomeWithOutput("spawn-failure", stdout, stderr);
  }
  const state = await monitorProjectCommand(
    child,
    stdout,
    stderr,
    signal,
    options.platform,
    options.processTimeoutMs,
    options.killGraceMs,
  );
  return outcomeFromRunState(state, stdout, stderr);
}
