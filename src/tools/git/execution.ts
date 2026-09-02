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

function cancellationError(executed: boolean): GitToolError {
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
): Promise<GitExecResult> {
  if (signal?.aborted) {
    throw cancellationError(false);
  }
  let result: GitExecResult;
  try {
    result = await exec("git", [...GIT_READ_ONLY_PREFIX, ...args], { cwd, signal });
  } catch {
    if (signal?.aborted) {
      throw cancellationError(true);
    }
    throw spawnError();
  }
  if (signal?.aborted) {
    throw cancellationError(true);
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim().replace(/\s+/gu, " ");
    throw commandFailure(
      `${operation} failed${detail ? `: ${detail}` : ` (exit code ${result.code})`}`,
    );
  }
  return result;
}
