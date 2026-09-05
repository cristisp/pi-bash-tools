import { spawn } from "node:child_process";
import { normalizeBooleanInput } from "../boolean.ts";
import {
  createToolErrorContract,
  suggestedActionForCategory,
  withToolErrorContract,
  type ResultCategory,
  type ToolErrorContract,
} from "../errors.ts";

const GIT_READ_ONLY_PREFIX = ["--no-optional-locks", "-c", "core.fsmonitor=false"] as const;

export interface GitExecOptions {
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
}

export interface GitExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly killed: boolean;
}

export type GitExec = (
  command: string,
  args: readonly string[],
  options?: GitExecOptions,
) => Promise<GitExecResult>;

const CHILD_TERMINATION_GRACE_MS = 100;

/**
 * Raised when captured Git output exceeds the configured bound.
 *
 * The distinct type keeps an output-bound breach identifiable after it crosses an executor
 * boundary, so it is never confused with a failure to start the command.
 */
export class GitOutputLimitError extends Error {
  readonly maxOutputBytes: number;

  constructor(maxOutputBytes: number) {
    super(`Git output exceeded the configured limit of ${maxOutputBytes} bytes`);
    this.name = "GitOutputLimitError";
    this.maxOutputBytes = maxOutputBytes;
  }
}

export function boundedGitExec(
  command: string,
  args: readonly string[],
  options: GitExecOptions,
  maxOutputBytes: number,
): Promise<GitExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    // The pipes are destroyed while a termination is in flight, so a stream-level error must not
    // escape as an uncaught exception in the host process. Settlement stays driven by "close".
    child.stdout.on("error", () => undefined);
    child.stderr.on("error", () => undefined);
    let outputBytes = 0;
    let settled = false;
    let terminationRequested = false;
    let aborted = false;
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const removeAbortListener = (): void => {
      options.signal?.removeEventListener("abort", abort);
    };
    const settleFailure = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      removeAbortListener();
      reject(error);
    };
    const requestTermination = (error: Error): void => {
      if (settled) return;
      failure ??= error;
      if (terminationRequested) return;
      terminationRequested = true;
      removeAbortListener();
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.pid === undefined) {
        settleFailure(failure ?? error);
        return;
      }
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, CHILD_TERMINATION_GRACE_MS);
    };
    const capture = (target: Buffer[], chunk: Buffer): void => {
      if (settled || terminationRequested) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        requestTermination(new GitOutputLimitError(maxOutputBytes));
        return;
      }
      target.push(chunk);
    };
    const abort = (): void => {
      aborted = true;
      requestTermination(new Error("Git command cancelled"));
    };

    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", (error) => {
      if (child.pid === undefined) {
        settleFailure(error);
      } else {
        requestTermination(error);
      }
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      removeAbortListener();
      if (failure !== undefined) {
        reject(failure);
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: code ?? -1,
        killed: aborted || signal !== null,
      });
    });
    if (options.signal?.aborted) {
      abort();
    } else {
      options.signal?.addEventListener("abort", abort, { once: true });
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class GitToolError extends Error {
  readonly details: unknown;
  readonly contract: ToolErrorContract;

  constructor(message: string, details?: unknown, contract?: ToolErrorContract) {
    super(message);
    this.name = "GitToolError";
    this.contract =
      contract ??
      createToolErrorContract({
        code: "git-error",
        category: "IMPLEMENTATION_FAILURE",
        explanation: message,
        suggestedAction: suggestedActionForCategory("IMPLEMENTATION_FAILURE"),
        retryable: true,
        executed: false,
      });
    this.details = isRecord(details)
      ? withToolErrorContract(details, this.contract)
      : withToolErrorContract({}, this.contract);
  }
}

function gitContract(
  code: string,
  category: Exclude<ResultCategory, "PASS">,
  explanation: string,
  retryable: boolean,
  executed: boolean,
  invalidField?: string,
): ToolErrorContract {
  return createToolErrorContract({
    code,
    category,
    explanation,
    ...(invalidField === undefined ? {} : { invalidField }),
    suggestedAction: suggestedActionForCategory(category),
    retryable,
    executed,
  });
}

export function invalidGitRequest(message: string, invalidField?: string): GitToolError {
  const action =
    invalidField === undefined
      ? "Correct the request shape or value and retry."
      : `Correct the ${invalidField} field or request shape and retry.`;
  const contract = gitContract(
    "invalid-request",
    "INVALID_REQUEST",
    "The Git request contains an invalid value.",
    false,
    false,
    invalidField,
  );
  return new GitToolError(
    `${message}; action: ${action}`,
    withToolErrorContract({ remediation: action }, contract),
    contract,
  );
}

export function normalizeGitBoolean(value: unknown, label: string): boolean | undefined {
  try {
    return normalizeBooleanInput(value, label);
  } catch {
    throw invalidGitRequest(
      `${label} must be a boolean or the literal string "true" or "false"`,
      label,
    );
  }
}

export function validateGitRequestKeys(
  value: unknown,
  allowedKeys: readonly string[],
  shape: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidGitRequest(`request must be an object matching ${shape}`);
  }
  const invalidKey = Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (invalidKey !== undefined) {
    throw invalidGitRequest(
      `unsupported request field "${invalidKey}"; accepted shape: ${shape}`,
      invalidKey,
    );
  }
}

export function cancellationError(executed: boolean): GitToolError {
  const contract = gitContract(
    "cancelled",
    "CANCELLED",
    "The Git operation was cancelled.",
    true,
    executed,
  );
  const error = new GitToolError(
    "Git command cancelled",
    withToolErrorContract({}, contract),
    contract,
  );
  error.name = "AbortError";
  return error;
}

function spawnError(): GitToolError {
  const contract = gitContract(
    "spawn-failure",
    "SPAWN_FAILURE",
    "The Git command could not be started.",
    true,
    true,
  );
  return new GitToolError(
    "Git command could not be started",
    withToolErrorContract({}, contract),
    contract,
  );
}

function commandFailure(message: string): GitToolError {
  const contract = gitContract(
    "git-command-failure",
    "IMPLEMENTATION_FAILURE",
    "The Git command exited with a nonzero status.",
    true,
    true,
  );
  return new GitToolError(message, withToolErrorContract({}, contract), contract);
}

/**
 * The single output-limit contract. Both the streaming producer inside `boundedGitExec` and the
 * post-execution byte-length check in `runGit` report through it, and an identical retry
 * reproduces the breach, so the contract is not retryable.
 */
function outputLimitFailure(operation: string, maxOutputBytes: number): GitToolError {
  const contract = gitContract(
    "git-output-limit-exceeded",
    "IMPLEMENTATION_FAILURE",
    "The Git command output exceeded the configured limit.",
    false,
    true,
  );
  return new GitToolError(
    `${operation} exceeded the ${maxOutputBytes}-byte output limit`,
    withToolErrorContract({}, contract),
    contract,
  );
}

export function gitImplementationError(message: string, executed = true): GitToolError {
  const contract = gitContract(
    "git-repository-resolution-failure",
    "IMPLEMENTATION_FAILURE",
    "The Git repository could not be resolved.",
    true,
    executed,
  );
  return new GitToolError(message, withToolErrorContract({}, contract), contract);
}

export function validateGitText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidGitRequest(`${label} must not be empty`, label);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      throw invalidGitRequest(`${label} contains a control character`, label);
    }
  }
}

export function containsPathspecCharacter(value: string): boolean {
  return (
    value.includes("\\") ||
    value.includes("*") ||
    value.includes("?") ||
    value.includes("[") ||
    value.includes("]")
  );
}

export function validateRevision(revision: unknown): string {
  validateGitText(revision, "revision");
  if (
    revision.startsWith("-") ||
    revision.includes("--") ||
    revision.includes(":") ||
    /\s/u.test(revision) ||
    containsPathspecCharacter(revision) ||
    !/^[A-Za-z0-9_./@^~{}+=,-]+$/u.test(revision)
  ) {
    throw invalidGitRequest("revision is not a safe Git revision expression", "revision");
  }
  return revision;
}

export async function runGit(
  exec: GitExec,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
  operation: string,
  maxOutputBytes?: number,
): Promise<GitExecResult> {
  if (signal?.aborted) {
    throw cancellationError(false);
  }
  let result: GitExecResult;
  try {
    result = await exec("git", [...GIT_READ_ONLY_PREFIX, ...args], {
      cwd,
      signal,
      ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    });
  } catch (error) {
    if (signal?.aborted) {
      throw cancellationError(true);
    }
    if (error instanceof GitOutputLimitError) {
      throw outputLimitFailure(operation, maxOutputBytes ?? error.maxOutputBytes);
    }
    throw spawnError();
  }
  if (signal?.aborted) {
    throw cancellationError(true);
  }
  if (
    maxOutputBytes !== undefined &&
    Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8") >
      maxOutputBytes
  ) {
    throw outputLimitFailure(operation, maxOutputBytes);
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim().replace(/\s+/gu, " ");
    throw commandFailure(
      `${operation} failed${detail ? `: ${detail}` : ` (exit code ${result.code})`}`,
    );
  }
  return result;
}
