export const VERIFY_PHASES = ["format", "lint", "typecheck", "test"] as const;
export const VERIFY_CACHE_FORMAT_VERSION = 2 as const;

export type VerifyPhase = (typeof VERIFY_PHASES)[number];
export type VerifyStepStatus = "passed" | "failed" | "omitted" | "not-run";
export type VerifyVerdict = "passed" | "failed" | "incomplete";

export interface VerifyOutputChunk {
  readonly text: string;
  readonly truncated: boolean;
  readonly totalBytes: number;
  readonly totalLines: number;
}

export interface VerifyStepResult {
  readonly phase: VerifyPhase;
  readonly status: VerifyStepStatus;
  readonly verdict: "passed" | "failed" | "omitted" | "not-run";
  readonly command?: string;
  readonly resolvedCommand?: string;
  readonly executable?: string;
  readonly args?: readonly string[];
  readonly script?: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly executed: boolean;
  readonly stdout: VerifyOutputChunk;
  readonly stderr: VerifyOutputChunk;
  readonly failureTail?: string;
  readonly reason?: string;
}

export interface VerifyRepositoryState {
  readonly repositoryIdentity: string;
  readonly workingDirectory: string;
  readonly head: string;
  readonly dirtyFilesDigest: string;
}

export interface VerifyEvidenceRecord {
  readonly cacheFormatVersion: typeof VERIFY_CACHE_FORMAT_VERSION;
  readonly key: string;
  readonly ref: string;
  readonly projectPath: string;
  readonly repositoryState?: VerifyRepositoryState;
  readonly resolvedCommands: readonly string[];
  readonly perStep: readonly VerifyStepResult[];
  readonly verdict: VerifyVerdict;
  readonly failureTail?: string;
  readonly covers: readonly string[];
  readonly createdAt: number;
}

export interface VerifyOutput {
  readonly status: "completed" | "unchanged";
  readonly verdict: VerifyVerdict;
  readonly ref?: string;
  readonly projectPath: string;
  readonly perStep: readonly VerifyStepResult[];
  readonly failureTail?: string;
  readonly reused: boolean;
  readonly covers: readonly string[];
  readonly repositoryState?: VerifyRepositoryState;
}
