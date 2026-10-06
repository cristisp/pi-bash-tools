import { Type } from "typebox";

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
  readonly coercions?: readonly string[];
  readonly provenance?: VerifyEvidenceProvenance;
  readonly publication?: VerifyPublication;
  readonly mutating?: boolean;
  readonly concurrentExecutions?: number;
  readonly stateDrift?: boolean;
  readonly sharedExecution?: boolean;
}

const verifyOutputChunkSchema = Type.Object(
  {
    text: Type.String({ description: "Bounded stream text." }),
    truncated: Type.Boolean({ description: "Whether the stream text was bounded." }),
    totalBytes: Type.Integer({ description: "Inspected UTF-8 byte count.", minimum: 0 }),
    totalLines: Type.Integer({ description: "Full stream line count.", minimum: 0 }),
  },
  { additionalProperties: false },
);

const verifyStepResultSchema = Type.Object(
  {
    phase: Type.Union(
      VERIFY_PHASES.map((phase) => Type.Literal(phase)),
      { description: "Verification phase." },
    ),
    status: Type.Union(
      ["passed", "failed", "omitted", "not-run"].map((value) => Type.Literal(value)),
      { description: "Step execution status." },
    ),
    verdict: Type.Union(
      ["passed", "failed", "omitted", "not-run"].map((value) => Type.Literal(value)),
      { description: "Step verdict." },
    ),
    command: Type.Optional(
      Type.String({ description: "Package script name that selected the step." }),
    ),
    resolvedCommand: Type.Optional(
      Type.String({ description: "Resolved package script command." }),
    ),
    executable: Type.Optional(Type.String({ description: "Executed executable." })),
    args: Type.Optional(
      Type.Array(Type.String(), { description: "Executed arguments after the executable." }),
    ),
    script: Type.Optional(Type.String({ description: "Executed package script definition." })),
    exitCode: Type.Union([Type.Integer(), Type.Null()], {
      description: "Process exit code, or null when the step did not run.",
    }),
    signal: Type.Union([Type.String(), Type.Null()], {
      description: "Termination signal, or null.",
    }),
    durationMs: Type.Number({ description: "Rounded step duration in milliseconds.", minimum: 0 }),
    executed: Type.Boolean({ description: "Whether the step actually executed." }),
    stdout: verifyOutputChunkSchema,
    stderr: verifyOutputChunkSchema,
    failureTail: Type.Optional(Type.String({ description: "Bounded tail of the failing stream." })),
    reason: Type.Optional(
      Type.String({ description: "Bounded reason for omitted or not-run steps." }),
    ),
  },
  { additionalProperties: false },
);

const verifyRepositoryStateSchema = Type.Object(
  {
    repositoryIdentity: Type.String({ description: "Canonical repository identity." }),
    workingDirectory: Type.String({ description: "Working directory used for the run." }),
    head: Type.String({ description: "Current HEAD commit." }),
    dirtyFilesDigest: Type.String({
      description: "SHA-256 digest of the observed dirty-file identities.",
    }),
  },
  { additionalProperties: false },
);

const verifyEvidenceProvenanceSchema = Type.Object(
  {
    scope: Type.Union([Type.Literal("root"), Type.Literal("flow")], {
      description: "Evidence scope of the producing run.",
    }),
    flowId: Type.Optional(Type.String({ description: "Producer flow identifier." })),
    repositoryIdentity: Type.Optional(
      Type.String({ description: "Repository identity of the producing run." }),
    ),
  },
  { additionalProperties: false },
);

const verifyPublicationSchema = Type.Object(
  {
    flowId: Type.String({ description: "Target flow identifier." }),
    repositoryIdentity: Type.String({ description: "Repository identity of the publication." }),
    producerScope: Type.Union([Type.Literal("root"), Type.Literal("flow")], {
      description: "Producer scope of the publication.",
    }),
    published: Type.Boolean({ description: "Whether the evidence was published." }),
  },
  { additionalProperties: false },
);

export const verifyOutputSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("completed"), Type.Literal("unchanged")], {
      description: "Whether the run completed or the cached result was unchanged.",
    }),
    verdict: Type.Union(
      [Type.Literal("passed"), Type.Literal("failed"), Type.Literal("incomplete")],
      { description: "Overall verification verdict." },
    ),
    ref: Type.Optional(Type.String({ description: "Stable vr_ evidence reference for the run." })),
    projectPath: Type.String({ description: "Canonical project directory." }),
    perStep: Type.Array(verifyStepResultSchema, {
      description: "Per-phase results in fixed order.",
    }),
    failureTail: Type.Optional(
      Type.String({ description: "Bounded tail of the failing phase output." }),
    ),
    reused: Type.Boolean({ description: "Whether the result came from the evidence cache." }),
    covers: Type.Array(Type.String(), {
      description: "Acceptance-criteria identifiers attached to the evidence.",
    }),
    repositoryState: Type.Optional(verifyRepositoryStateSchema),
    recordedRepositoryState: Type.Optional(verifyRepositoryStateSchema),
    currentRepositoryState: Type.Optional(verifyRepositoryStateSchema),
    repositoryStateStatus: Type.Union(
      [Type.Literal("matches"), Type.Literal("mismatch"), Type.Literal("unreadable")],
      { description: "Comparison between the recorded and current repository state." },
    ),
    coercions: Type.Optional(
      Type.Array(Type.String(), { description: "Request fields normalized or rejected up front." }),
    ),
    provenance: Type.Optional(verifyEvidenceProvenanceSchema),
    publication: Type.Optional(verifyPublicationSchema),
    mutating: Type.Optional(
      Type.Boolean({ description: "Whether the run can mutate the project (format phase)." }),
    ),
    concurrentExecutions: Type.Optional(
      Type.Integer({ description: "Detected concurrent verify executions.", minimum: 1 }),
    ),
    stateDrift: Type.Optional(
      Type.Boolean({ description: "Whether repository state drifted during the run." }),
    ),
    sharedExecution: Type.Optional(
      Type.Boolean({
        description: "Whether the result was produced by another concurrent execution.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      "Bounded verification result, also returned as the model-facing JSON text. Failures throw and carry no structured content.",
  },
);
