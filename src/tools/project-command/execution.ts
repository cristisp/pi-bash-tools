import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { decodeUtf8Prefix, decodeUtf8Suffix } from "../truncation.ts";
import {
  PROJECT_COMMAND_OUTPUT_LIMIT_BYTES,
  type ProjectCommandDefinition,
} from "./definitions.ts";
import { resolveFixedProjectCommand, type ResolvedProjectCommand } from "./resolution.ts";

export type ProjectCommandExecutionStatus =
  | "success"
  | "nonzero"
  | "timeout"
  | "spawn-failure"
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
  readonly structuredDetails?: unknown;
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

function environmentForProfile(
  profile: ProjectCommandDefinition["sanitizedEnvironmentProfile"],
): NodeJS.ProcessEnv {
  if (profile !== "node-v1") {
    return { ...STATIC_ENVIRONMENT };
  }
  return {
    ...STATIC_ENVIRONMENT,
    HOME: process.env.HOME ?? homedir(),
    CI: "true",
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  };
}
const DEFAULT_KILL_GRACE_MS = 150;

class Capture {
  private readonly chunks: Buffer[] = [];
  private retainedBytes = 0;
  private totalBytes = 0;
  private lineBreaks = 0;
  private hasContentSinceLineBreak = false;
  private previousWasCarriageReturn = false;
  private tailBytes = Buffer.alloc(0);

  constructor(
    private readonly limit: number,
    private readonly direction: "head" | "tail",
  ) {}

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
    if (this.direction === "head") {
      if (this.retainedBytes >= this.limit) {
        return;
      }
      const retained = chunk.subarray(0, this.limit - this.retainedBytes);
      this.chunks.push(retained);
      this.retainedBytes += retained.byteLength;
      return;
    }
    if (this.limit === 0) {
      return;
    }
    const combined = Buffer.concat([this.tailBytes, chunk]);
    this.tailBytes = combined.subarray(Math.max(0, combined.byteLength - this.limit));
  }

  output(): ProjectCommandOutput {
    const bytes =
      this.direction === "head" ? Buffer.concat(this.chunks, this.retainedBytes) : this.tailBytes;
    const truncated = this.totalBytes > this.limit;
    return {
      text:
        this.direction === "head"
          ? decodeUtf8Prefix(bytes, this.limit, truncated)
          : decodeUtf8Suffix(bytes),
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

function sendSignal(child: ChildProcess, platform: NodeJS.Platform, signal: NodeJS.Signals): void {
  try {
    if (platform === "darwin") {
      const pid = child.pid;
      if (typeof pid !== "number") {
        throw new Error("process cleanup is unsupported");
      }
      process.kill(-pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (!isAlreadyExited(error)) {
      throw error;
    }
  }
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

async function terminateChild(
  child: ChildProcess,
  platform: NodeJS.Platform,
  close: Promise<void>,
  graceMs: number,
): Promise<void> {
  let terminationError: unknown;
  try {
    sendSignal(child, platform, "SIGTERM");
  } catch (error) {
    terminationError = error;
  }
  if (!(await waitForCloseOrTimeout(close, graceMs))) {
    try {
      sendSignal(child, platform, "SIGKILL");
    } catch (error) {
      terminationError ??= error;
    }
    await close;
  }
  if (terminationError !== undefined) {
    throw terminationError;
  }
}

function spawnProjectCommand(
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  return spawn(executable, [...args], options);
}

interface ChildRunState {
  exit: ProjectCommandExit;
  spawnFailure: boolean;
  timedOut: boolean;
  cancelled: boolean;
}

interface ChildMonitor {
  readonly state: ChildRunState;
  readonly close: Promise<void>;
  readonly termination: () => Promise<void> | undefined;
  readonly requestTermination: () => Promise<void>;
}

function setupChildMonitor(
  child: ChildProcess,
  stdout: Capture,
  stderr: Capture,
  platform: NodeJS.Platform,
  graceMs: number,
): ChildMonitor {
  const state: ChildRunState = {
    exit: { code: null, signal: null },
    spawnFailure: false,
    timedOut: false,
    cancelled: false,
  };
  let closeResolve!: () => void;
  const close = new Promise<void>((resolve) => {
    closeResolve = resolve;
  });
  const onClose = (code: number | null, childSignal: NodeJS.Signals | null): void => {
    state.exit = {
      code: typeof code === "number" ? code : null,
      signal: typeof childSignal === "string" ? childSignal : null,
    };
    closeResolve();
  };
  let termination: Promise<void> | undefined;
  const requestTermination = (): Promise<void> => {
    termination ??= terminateChild(child, platform, close, graceMs).catch(() => undefined);
    return termination;
  };
  const onError = (): void => {
    state.spawnFailure = true;
    void requestTermination();
  };
  child.once("error", onError);
  child.once("close", onClose);
  child.stdout!.on("data", (chunk: Buffer | string) => stdout.append(chunk));
  child.stderr!.on("data", (chunk: Buffer | string) => stderr.append(chunk));
  return { state, close, termination: () => termination, requestTermination };
}

async function monitorChild(
  monitor: ChildMonitor,
  signal: AbortSignal | undefined,
  processTimeoutMs: number,
): Promise<ChildRunState> {
  const onAbort = (): void => {
    monitor.state.cancelled = true;
    void monitor.requestTermination();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeoutId = setTimeout(
    () => {
      monitor.state.timedOut = true;
      void monitor.requestTermination();
    },
    Math.max(0, processTimeoutMs),
  );
  if (signal?.aborted) {
    onAbort();
  }
  try {
    await monitor.close;
    const termination = monitor.termination();
    if (termination !== undefined) {
      await termination;
    }
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onAbort);
  }
  return monitor.state;
}

function outcomeFromState(
  state: ChildRunState,
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
  if (state.timedOut) {
    return { status: "timeout", ...base };
  }
  if (state.spawnFailure) {
    return { status: "spawn-failure", ...base };
  }
  return { status: state.exit.code === 0 ? "success" : "nonzero", ...base };
}

type ProjectCommandExecutionInput = ResolvedProjectCommand | ProjectCommandDefinition;

function resolvedCommand(input: ProjectCommandExecutionInput): ResolvedProjectCommand {
  return "definition" in input ? input : resolveFixedProjectCommand(input);
}

async function executeProjectCommand(
  input: ProjectCommandExecutionInput,
  cwd: string,
  signal: AbortSignal | undefined,
  spawnCommand: ProjectCommandSpawn,
  platform: NodeJS.Platform,
  processTimeoutMs: number,
  graceMs: number,
): Promise<ProjectCommandExecutionOutcome> {
  const resolved = resolvedCommand(input);
  if (signal?.aborted) {
    return emptyOutcome("cancelled");
  }
  const limit = Math.min(resolved.definition.outputLimitBytes, PROJECT_COMMAND_OUTPUT_LIMIT_BYTES);
  const direction = resolved.definition.truncationDirection ?? "head";
  const stdout = new Capture(limit, direction);
  const stderr = new Capture(limit, direction);
  if (resolved.definition.executionKind === "in-process") {
    if (signal?.aborted) {
      return emptyOutcome("cancelled");
    }
    return {
      ...emptyOutcome("success"),
      structuredDetails: resolved.structuredDetails,
    };
  }
  let child: ChildProcess;
  try {
    child = spawnCommand(resolved.executable, resolved.args, {
      cwd,
      shell: false,
      detached: platform === "darwin",
      env: environmentForProfile(resolved.definition.sanitizedEnvironmentProfile),
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
  } catch {
    return outcomeWithOutput("spawn-failure", stdout, stderr);
  }
  try {
    const monitor = setupChildMonitor(child, stdout, stderr, platform, graceMs);
    const state = await monitorChild(monitor, signal, processTimeoutMs);
    return outcomeFromState(state, stdout, stderr);
  } catch {
    return outcomeWithOutput("spawn-failure", stdout, stderr);
  }
}

export function createProjectCommandExecutor(
  options: ProjectCommandExecutorOptions = {},
): (
  resolved: ProjectCommandExecutionInput,
  cwd: string,
  signal?: AbortSignal,
) => Promise<ProjectCommandExecutionOutcome> {
  const spawnCommand = options.spawn ?? spawnProjectCommand;
  const platform = options.platform ?? process.platform;
  const graceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  return (input, cwd, signal) => {
    const resolved = resolvedCommand(input);
    return executeProjectCommand(
      resolved,
      cwd,
      signal,
      spawnCommand,
      platform,
      options.processTimeoutMs ?? resolved.definition.processTimeoutMs,
      graceMs,
    );
  };
}
