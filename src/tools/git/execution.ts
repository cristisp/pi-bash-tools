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

export class GitToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitToolError";
  }
}

function cancellationError(): GitToolError {
  const error = new GitToolError("Git command cancelled");
  error.name = "AbortError";
  return error;
}

export function validateGitText(value: string, label: string): void {
  if (value.length === 0) {
    throw new GitToolError(`${label} must not be empty`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      throw new GitToolError(`${label} contains a control character`);
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

export function validateRevision(revision: string): string {
  validateGitText(revision, "revision");
  if (
    revision.startsWith("-") ||
    revision.includes("--") ||
    revision.includes(":") ||
    /\s/u.test(revision) ||
    containsPathspecCharacter(revision) ||
    !/^[A-Za-z0-9_./@^~{}+=,-]+$/u.test(revision)
  ) {
    throw new GitToolError("revision is not a safe Git revision expression");
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
    throw cancellationError();
  }
  const result = await exec("git", [...GIT_READ_ONLY_PREFIX, ...args], { cwd, signal });
  if (result.killed && signal?.aborted) {
    throw cancellationError();
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim().replace(/\s+/gu, " ");
    throw new GitToolError(
      `${operation} failed${detail ? `: ${detail}` : ` (exit code ${result.code})`}`,
    );
  }
  return result;
}
