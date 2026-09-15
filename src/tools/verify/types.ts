import type {
  SharedEvidenceKind,
  SharedEvidenceOutputBlock,
  SharedEvidenceWorkspaceBlock,
} from "../../evidence/envelope.ts";
import { EVIDENCE_PRODUCER } from "../../evidence/envelope.ts";

export const VERIFY_PHASES = ["format", "lint", "typecheck", "test"] as const;
export const VERIFY_CACHE_FORMAT_VERSION = 3 as const;

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

export type VerifyRepositoryStateStatus = "matches" | "mismatch" | "unreadable";
export type VerifyEvidenceScope = "root" | "flow";

export interface VerifyEvidenceProvenance {
  readonly scope: VerifyEvidenceScope;
  readonly flowId?: string;
  readonly repositoryIdentity?: string;
}

export interface VerifyPublication {
  readonly flowId: string;
  readonly repositoryIdentity: string;
  readonly producerScope: VerifyEvidenceScope;
  readonly published: boolean;
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
  readonly producer?: typeof EVIDENCE_PRODUCER;
  readonly kind?: SharedEvidenceKind;
  readonly requestHash?: string;
  readonly contentHash?: string;
  readonly workspace?: SharedEvidenceWorkspaceBlock;
  readonly output?: SharedEvidenceOutputBlock;
  readonly provenance?: VerifyEvidenceProvenance;
  readonly publication?: VerifyPublication;
  readonly mutating?: boolean;
  readonly concurrentExecutions?: number;
  readonly stateDrift?: boolean;
  readonly sharedExecution?: boolean;
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
  readonly recordedRepositoryState?: VerifyRepositoryState;
  readonly currentRepositoryState?: VerifyRepositoryState;
  readonly repositoryStateStatus?: VerifyRepositoryStateStatus;
  readonly provenance?: VerifyEvidenceProvenance;
  readonly publication?: VerifyPublication;
  readonly mutating?: boolean;
  readonly concurrentExecutions?: number;
  readonly stateDrift?: boolean;
  readonly sharedExecution?: boolean;
}
