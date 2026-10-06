import { createHash } from "node:crypto";
import {
  lstat as nodeLstat,
  readFile as nodeReadFile,
  realpath as nodeRealpath,
} from "node:fs/promises";
import { relative, sep } from "node:path";

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import {
  EVIDENCE_ENVELOPE_FORMAT_VERSION,
  EVIDENCE_PRODUCER,
  sharedEvidenceRequestHash,
  sharedRepositoryId,
  type SharedEvidenceRecord,
  type SharedEvidenceScope,
  type SharedEvidenceWorkspaceBlock,
} from "../../evidence/envelope.ts";
import type {
  AuthorizationOutcomeObserver,
  AuthorizationOutcomeRecorder,
} from "../../observability/authorization-outcome.ts";
import { createAuthorizationOutcomeObserver } from "../../observability/authorization-outcome.ts";
import { hashToolParameters } from "../../observability/canonical-json.ts";
import {
  recordReadBatchInvocation,
  type ReadBatchInvocationAggregate,
  type ReadBatchInvocationItem,
  type ReadBatchInvocationLookupMetadata,
  type ReadBatchInvocationPublicationMetadata,
  type ReadBatchInvocationReason,
  type ReadBatchInvocationRecorder,
} from "../../observability/read-batch-invocation.ts";
import type { BashToolAnnotations } from "../annotations.ts";
import type { AuthorizationRetryTracker } from "../authorization-retry.ts";
import { type AuthorizationErrorKind } from "../authorization.ts";
import { renderCallLine, renderStringArgument } from "../call-render.ts";
import type { GitExec } from "../git/execution.ts";
import { resolveRepository } from "../git/repository.ts";
import { isPathWithin } from "../path-containment.ts";
import { displayPath } from "../path-display.ts";
import { filesystemPolicyDenialMetadata } from "../policy/decisions.ts";
import {
  createNodePolicyFileSystem,
  type PolicyFileStats,
  type PolicyFileSystem,
} from "../policy/filesystem.ts";
import { createPolicyStore, createPolicyStoreForTesting } from "../policy/store.ts";
import type { LoadedPolicy, PolicyAuthorization, PolicyStore } from "../policy/types.ts";
import {
  effectiveOrchestrationFlowId,
  readProjectCommandOrchestrationContext,
} from "../project-command/orchestration.ts";
import type { ProjectCommandRepositoryStateReader } from "../project-command/repository-state.ts";
import { createProjectCommandRepositoryStateReader } from "../project-command/repository-state.ts";
import { stripNullProperties } from "../project-command/schema/validation.ts";
import { decodeUtf8Prefix } from "../truncation.ts";
import { FLOW_ID_PATTERN, toJsonValue } from "../value-validation.ts";
import {
  authorizeAndPersistFilesystemAccesses,
  loadFilesystemPolicyForRequest,
  type FilesystemAuthorizationContext,
  type FilesystemAuthorizationRequest,
} from "./authorization.ts";
import {
  filesystemAuthorizationContract,
  filesystemCancellationError,
  filesystemContract,
  filesystemError,
  filesystemInvalidRequest,
  FilesystemToolError,
} from "./errors.ts";
import { recordObservedContent } from "./observed-content-store.ts";
import { canonicalExistingPath, requestPath } from "./paths.ts";
import {
  resolveReadEvidenceLookup,
  type ReadEvidenceLookupOutcome,
  type ReadEvidenceLookupResult,
  type ReadEvidencePathProbe,
} from "./read-evidence-lookup.ts";
import {
  createPublishedReadEvidenceRecord,
  createReadEvidenceStore,
  type ReadEvidenceEntry,
  type ReadEvidenceStore,
} from "./read-evidence-store.ts";
import {
  READ_EVIDENCE_MAX_RECORD_BYTES,
  readEvidenceRecordBytes,
} from "./read-evidence-validation.ts";

const READ_BATCH_MAX_PATHS = 32;
const READ_BATCH_MAX_PATH_LENGTH = 4_096;
const READ_BATCH_MAX_OFFSET = 1_000_000;
const READ_BATCH_MAX_RANGE_LINES = 2_000;
const READ_BATCH_MAX_CONTENT_BYTES = 64 * 1024;
const READ_BATCH_MAX_AGGREGATE_CONTENT_BYTES = 256 * 1024;
const READ_BATCH_MAX_FILE_BYTES = 8 * 1024 * 1024;
const READ_BATCH_MAX_CACHE_ENTRIES = 512;
const READ_BATCH_REF_PREFIX = "rr_";
const READ_BATCH_REF_PATTERN = /^rr_[0-9a-f]{24}$/u;
const READ_BATCH_MAX_FLOW_ID_LENGTH = 64;
const READ_BATCH_MAX_COVERS = 64;
const READ_BATCH_MAX_COVER_LENGTH = 512;
const READ_BATCH_INPUT_KEYS = new Set(["paths", "ref", "flowId", "covers", "publish"]);

const readBatchRangeParameters = Type.Object(
  {
    offset: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: READ_BATCH_MAX_OFFSET,
        description: "1-indexed line number to start reading from",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: READ_BATCH_MAX_RANGE_LINES,
        description: "Maximum number of lines to read",
      }),
    ),
  },
  {
    additionalProperties: false,
    description: "Optional line range; omit both fields to read the complete file.",
  },
);

const readBatchPathParameters = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      maxLength: READ_BATCH_MAX_PATH_LENGTH,
      description: "Non-empty repository-relative path to a regular file",
    }),
    range: Type.Optional(readBatchRangeParameters),
  },
  {
    additionalProperties: false,
    description: "One repository-relative file and optional bounded line range to read.",
  },
);

const readBatchPublishParameters = Type.Object(
  {
    flowId: Type.String({
      minLength: 1,
      maxLength: READ_BATCH_MAX_FLOW_ID_LENGTH,
      pattern: FLOW_ID_PATTERN.source,
      description: "Flow ID authorized to receive the freshly read evidence",
    }),
  },
  {
    additionalProperties: false,
    description:
      "Execution-only publication request. The resulting aggregate ref is durable and lookupable by authorized children in this flow.",
  },
);

const readBatchParameters = Type.Object(
  {
    paths: Type.Optional(
      Type.Union([
        Type.Array(readBatchPathParameters, {
          minItems: 1,
          maxItems: READ_BATCH_MAX_PATHS,
          description:
            "Execution request: one or more repository-relative files to read. Required unless ref is supplied for lookup.",
        }),
        Type.Null(),
      ]),
    ),
    ref: Type.Optional(
      Type.Union([
        Type.String({
          pattern: "^rr_[0-9a-f]{24}$",
          maxLength: 32,
          description:
            "Lookup request: previously published read_batch evidence ref. Use this instead of paths; it must not be combined with publish.",
        }),
        Type.Null(),
      ]),
    ),
    flowId: Type.Optional(
      Type.Union([
        Type.String({
          minLength: 1,
          maxLength: READ_BATCH_MAX_FLOW_ID_LENGTH,
          pattern: FLOW_ID_PATTERN.source,
          description:
            "Lookup-only flow scope; requires ref. For execution publication, use publish.flowId instead.",
        }),
        Type.Null(),
      ]),
    ),
    covers: Type.Optional(
      Type.Union([
        Type.Array(
          Type.String({
            minLength: 1,
            maxLength: READ_BATCH_MAX_COVER_LENGTH,
            description: "Acceptance-criteria identifier to associate with this lookup",
          }),
          {
            maxItems: READ_BATCH_MAX_COVERS,
            description:
              "Optional bounded acceptance-criteria identifiers for a published-ref lookup; valid only with ref.",
          },
        ),
        Type.Null(),
      ]),
    ),
    publish: Type.Optional(
      Type.Union([readBatchPublishParameters, Type.Null()], {
        description:
          "Optional execution-only publication. Do not combine with ref; publication must target the caller's authorized flow.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      "Two request forms are supported: execution uses paths and may include publish.flowId; lookup uses ref and may include flowId and covers. Do not combine execution and lookup fields. Explicit null on optional fields is treated as omitted, and invalid combinations are rejected at runtime.",
  },
);

type ReadBatchInput = Static<typeof readBatchParameters>;

export { readBatchParameters };
export type { ReadBatchInput };

export interface ReadBatchRange {
  readonly offset?: number;
  readonly limit?: number;
}

export interface ReadBatchOutput {
  readonly truncated: boolean;
  readonly totalBytes: number;
  readonly totalLines: number;
}

export type ReadBatchPathError = Readonly<Record<string, unknown>> & {
  readonly code: string;
  readonly message: string;
};

export interface ReadBatchPathResult {
  readonly path: string;
  readonly range?: ReadBatchRange;
  readonly unchanged?: boolean;
  readonly ref?: string;
  readonly contentHash?: string;
  readonly content?: string;
  readonly output?: ReadBatchOutput;
  readonly error?: ReadBatchPathError;
}

export interface ReadBatchContinuation {
  readonly nextIndex: number;
  readonly totalPaths: number;
}

export interface ReadBatchPublicationMetadata {
  readonly scope: "flow";
  readonly flowId: string;
  readonly published: boolean;
  readonly ref?: string;
  readonly error?: string;
}

export interface ReadBatchDetails {
  readonly results: readonly ReadBatchPathResult[];
  readonly continuation?: ReadBatchContinuation;
  readonly publish?: ReadBatchPublicationMetadata;
  readonly lookup?: ReadEvidenceLookupResult;
  readonly coercions?: readonly string[];
}

const readBatchOutputBlockSchema = Type.Object(
  {
    truncated: Type.Boolean({ description: "Whether text was bounded." }),
    totalBytes: Type.Integer({ description: "Inspected UTF-8 byte count.", minimum: 0 }),
    totalLines: Type.Integer({ description: "Full-file line count.", minimum: 0 }),
  },
  { additionalProperties: false },
);

const readBatchRangeSchema = Type.Object(
  {
    offset: Type.Optional(Type.Integer({ description: "1-indexed first line.", minimum: 1 })),
    limit: Type.Optional(Type.Integer({ description: "Line count.", minimum: 1 })),
  },
  { additionalProperties: false },
);

const readBatchPathErrorSchema = Type.Object(
  {
    code: Type.String({ description: "Stable error code." }),
    message: Type.String({ description: "Bounded model-facing error text." }),
    category: Type.Optional(Type.String({ description: "Error category." })),
    retryable: Type.Optional(Type.Boolean({ description: "Whether a retry may succeed." })),
    executed: Type.Optional(Type.Boolean({ description: "Whether work executed before failing." })),
    ruleKind: Type.Optional(Type.String({ description: "Policy rule classification." })),
    authorizedRoots: Type.Optional(
      Type.Array(Type.String(), {
        description: "Authorized root paths supporting the denial, bounded.",
      }),
    ),
  },
  { additionalProperties: false },
);

const readBatchPathResultSchema = Type.Object(
  {
    path: Type.String({ description: "Workspace-relative path of the read file." }),
    range: Type.Optional(readBatchRangeSchema),
    unchanged: Type.Optional(
      Type.Boolean({ description: "True when the item served an unchanged prior read." }),
    ),
    ref: Type.Optional(
      Type.String({ description: "Process-local rr_ read evidence reference for this item." }),
    ),
    contentHash: Type.Optional(
      Type.String({ description: "Lowercase SHA-256 digest of the full file bytes." }),
    ),
    content: Type.Optional(Type.String({ description: "Bounded file text." })),
    output: Type.Optional(readBatchOutputBlockSchema),
    error: Type.Optional(readBatchPathErrorSchema),
  },
  { additionalProperties: false },
);

const readEvidenceLookupEntrySchema = Type.Object(
  {
    path: Type.String({ description: "Workspace-relative path of the recorded entry." }),
    range: Type.Optional(readBatchRangeSchema),
    contentHash: Type.Optional(
      Type.String({ description: "Lowercase SHA-256 digest of the recorded file bytes." }),
    ),
    status: Type.Union(
      [
        Type.Literal("unchanged"),
        Type.Literal("changed"),
        Type.Literal("unreadable"),
        Type.Literal("unauthorized"),
      ],
      { description: "Reauthorization and re-derivation status of the recorded entry." },
    ),
    content: Type.Optional(
      Type.String({ description: "Bounded stored text, present only when unchanged." }),
    ),
    output: Type.Optional(readBatchOutputBlockSchema),
  },
  { additionalProperties: false },
);

const sharedEvidenceWorkspaceBlockSchema = Type.Object(
  {
    repositoryId: Type.String({ description: "SHA-256 hex digest of the repository identity." }),
    head: Type.Union([Type.String(), Type.Null()], {
      description: "Repository HEAD commit, or null when unavailable.",
    }),
    dirtyDigest: Type.Union([Type.String(), Type.Null()], {
      description: "SHA-256 hex digest of the dirty-file identities, or null when unavailable.",
    }),
    status: Type.Union([Type.Literal("readable"), Type.Literal("degraded")], {
      description: "Observation health.",
    }),
  },
  { additionalProperties: false },
);

const readBatchLookupSchema = Type.Object(
  {
    ref: Type.String({ description: "Resolved rr_ read evidence reference." }),
    covers: Type.Optional(
      Type.Array(Type.String(), { description: "Attribution identifiers requested with the ref." }),
    ),
    executed: Type.Literal(false),
    repositoryStateStatus: Type.Union(
      [Type.Literal("matches"), Type.Literal("mismatch"), Type.Literal("unreadable")],
      {
        description: "Workspace comparison status between the stored and the current observation.",
      },
    ),
    entries: Type.Array(readEvidenceLookupEntrySchema, {
      description: "Per-path reauthorization and content re-derivation results.",
    }),
    workspace: Type.Optional(sharedEvidenceWorkspaceBlockSchema),
    currentWorkspace: Type.Optional(sharedEvidenceWorkspaceBlockSchema),
  },
  { additionalProperties: false },
);

const readBatchPublicationSchema = Type.Object(
  {
    scope: Type.Literal("flow"),
    flowId: Type.String({ description: "Target orchestration flow identifier." }),
    published: Type.Boolean({ description: "Whether the evidence was published." }),
    ref: Type.Optional(Type.String({ description: "Published rr_ reference on success." })),
    error: Type.Optional(Type.String({ description: "Bounded publication error." })),
  },
  { additionalProperties: false },
);

export const readBatchDetailsSchema = Type.Object(
  {
    results: Type.Array(readBatchPathResultSchema, {
      description: "Per-path results in request order.",
    }),
    continuation: Type.Optional(
      Type.Object(
        {
          nextIndex: Type.Integer({
            description: "Request index of the first skipped path.",
            minimum: 0,
          }),
          totalPaths: Type.Integer({
            description: "Total requested path count.",
            minimum: 1,
            maximum: 32,
          }),
        },
        { additionalProperties: false },
      ),
    ),
    publish: Type.Optional(readBatchPublicationSchema),
    lookup: Type.Optional(readBatchLookupSchema),
    coercions: Type.Optional(
      Type.Array(Type.String(), {
        description: "Descriptions of request fields normalized or rejected up front.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      "Bounded batch read or evidence lookup payload, also returned as the model-facing JSON text.",
  },
);

export type ReadBatchToolContext = FilesystemAuthorizationContext & {
  readonly sessionManager?: Pick<ExtensionContext["sessionManager"], "getSessionId">;
};

interface ReadBatchFileStats extends PolicyFileStats {
  readonly size: number;
}

export interface ReadBatchFileSystem {
  readonly lstat: (path: string) => Promise<ReadBatchFileStats>;
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly realpath: (path: string) => Promise<string>;
}

export interface ReadBatchToolTestOptions {
  readonly configPath?: string;
  readonly fs?: Partial<ReadBatchFileSystem>;
  readonly gitExec?: GitExec;
  readonly policy?: PolicyStore;
  readonly invocationRecorder?: ReadBatchInvocationRecorder;
  readonly repositoryStateReader?: ProjectCommandRepositoryStateReader;
  readonly authorizationOutcomeRecorder?: AuthorizationOutcomeRecorder;
  readonly authorizationRetryTracker?: AuthorizationRetryTracker;
  readonly readEvidenceStore?: ReadEvidenceStore;
}

export interface ReadBatchToolOptions {
  readonly invocationRecorder?: ReadBatchInvocationRecorder;
  readonly repositoryStateReader?: ProjectCommandRepositoryStateReader;
  readonly authorizationOutcomeRecorder?: AuthorizationOutcomeRecorder;
  readonly authorizationRetryTracker?: AuthorizationRetryTracker;
}

type ReadBatchExecute = (
  toolCallId: string,
  params: ReadBatchInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<ReadBatchDetails> | undefined,
  ctx: ReadBatchToolContext,
) => Promise<AgentToolResult<ReadBatchDetails>>;

export type ReadBatchToolDefinition = Omit<
  ToolDefinition<typeof readBatchParameters, ReadBatchDetails>,
  "execute"
> & { annotations?: BashToolAnnotations; execute: ReadBatchExecute };

interface NormalizedReadBatchPath {
  readonly path: string;
  readonly range?: ReadBatchRange;
}

interface NormalizedReadBatchExecuteRequest {
  readonly kind: "execute";
  readonly paths: ReadonlyArray<NormalizedReadBatchPath>;
  readonly publishFlowId?: string;
}

interface NormalizedReadBatchLookupRequest {
  readonly kind: "lookup";
  readonly ref: string;
  readonly flowId?: string;
  readonly covers?: readonly string[];
}

type NormalizedReadBatchRequest =
  | NormalizedReadBatchExecuteRequest
  | NormalizedReadBatchLookupRequest;

interface PreviousRead {
  readonly evidence: SharedEvidenceRecord;
}

interface ReadBatchPathFailureOptions {
  readonly code: string;
  readonly message: string;
  readonly category?: string;
  readonly retryable?: boolean;
  readonly executed?: boolean;
  readonly ruleKind?: string;
  readonly authorizedRoots?: readonly string[];
}

const DENIED_POLICY_SCOPES: Record<PolicyAuthorization, string> = {
  "deny-global": "the global",
  "deny-project": "the project",
  "allow-global": "a configured",
  "allow-project": "a configured",
  unknown: "a configured",
};

const BLOCKED_REASON_SUFFIXES: Record<Exclude<AuthorizationErrorKind, "denied">, string> = {
  "denied-once": " was denied for this request.",
  "not-authorized": " requires approval that is unavailable in this mode.",
  timeout: " confirmation timed out; a project deny rule was recorded.",
  confirmation: " confirmation failed.",
  save: "; the access policy could not be saved.",
  load: "; the access policy could not be loaded.",
  "invalid-choice": "; the access policy returned an invalid approval.",
  "unsafe-global": "; the access policy returned an invalid approval.",
  "unchanged-retry": " was already denied for this identical request.",
  cancelled: " confirmation was cancelled.",
  dismissed: " confirmation was dismissed.",
};

function createNodeFileSystem(): ReadBatchFileSystem {
  return {
    lstat: (path) => nodeLstat(path),
    readFile: (path) => nodeReadFile(path),
    realpath: (path) => nodeRealpath(path),
  };
}

function createFileSystem(options: ReadBatchToolTestOptions): ReadBatchFileSystem {
  const defaults = createNodeFileSystem();
  return {
    ...defaults,
    ...(options.fs?.lstat === undefined ? {} : { lstat: options.fs.lstat }),
    ...(options.fs?.readFile === undefined ? {} : { readFile: options.fs.readFile }),
    ...(options.fs?.realpath === undefined ? {} : { realpath: options.fs.realpath }),
  };
}

function requirePolicy(
  options: ReadBatchToolTestOptions,
  fileSystem: ReadBatchFileSystem,
): PolicyStore {
  if (options.policy !== undefined) return options.policy;
  if (options.configPath === undefined) {
    throw filesystemInvalidRequest("A policy or config path is required for testing", "configPath");
  }
  const policyFileSystem: PolicyFileSystem = {
    ...createNodePolicyFileSystem(),
    lstat: fileSystem.lstat,
    realpath: fileSystem.realpath,
  };
  return createPolicyStoreForTesting({ configPath: options.configPath, fs: policyFileSystem });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function repositoryRelativePath(root: string, path: string): string | undefined {
  if (!isPathWithin(root, path)) return undefined;
  return relative(root, path).split(sep).join("/") || ".";
}

function reportedPath(root: string, cwd: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "<invalid-path>";
  try {
    const candidate = requestPath(value, cwd);
    return repositoryRelativePath(root, candidate) ?? "<outside-repository>";
  } catch {
    return "<invalid-path>";
  }
}

function normalizeRange(value: unknown): ReadBatchRange | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw filesystemInvalidRequest("range must be an object", "range");
  }
  const invalidKey = Object.keys(value).find((key) => key !== "offset" && key !== "limit");
  if (invalidKey !== undefined) {
    throw filesystemInvalidRequest(`unsupported range field "${invalidKey}"`, "range");
  }
  const offset = value.offset;
  const limit = value.limit;
  if (
    offset !== undefined &&
    (typeof offset !== "number" ||
      !Number.isInteger(offset) ||
      offset < 1 ||
      offset > READ_BATCH_MAX_OFFSET)
  ) {
    throw filesystemInvalidRequest(
      `range.offset must be an integer from 1 through ${READ_BATCH_MAX_OFFSET}`,
      "range.offset",
    );
  }
  if (
    limit !== undefined &&
    (typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > READ_BATCH_MAX_RANGE_LINES)
  ) {
    throw filesystemInvalidRequest(
      `range.limit must be an integer from 1 through ${READ_BATCH_MAX_RANGE_LINES}`,
      "range.limit",
    );
  }
  if (offset === undefined && limit === undefined) return undefined;
  return Object.freeze({
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
  });
}

function normalizePathInput(value: unknown): NormalizedReadBatchPath {
  if (!isRecord(value)) {
    throw filesystemInvalidRequest("each paths entry must be an object", "paths");
  }
  const invalidKey = Object.keys(value).find((key) => key !== "path" && key !== "range");
  if (invalidKey !== undefined) {
    throw filesystemInvalidRequest(`unsupported paths entry field "${invalidKey}"`, "paths");
  }
  if (typeof value.path !== "string" || value.path.length === 0) {
    throw filesystemInvalidRequest("paths entries require a non-empty path", "paths");
  }
  if (value.path.length > READ_BATCH_MAX_PATH_LENGTH) {
    throw filesystemInvalidRequest(
      `paths entries must be at most ${READ_BATCH_MAX_PATH_LENGTH} characters`,
      "paths",
    );
  }
  const range = normalizeRange(value.range);
  return {
    path: value.path,
    ...(range === undefined ? {} : { range }),
  };
}

function normalizePublishInput(value: unknown): string {
  if (!isRecord(value)) {
    throw filesystemInvalidRequest("publish must be an object with a flowId", "publish");
  }
  const invalidKey = Object.keys(value).find((key) => key !== "flowId");
  if (invalidKey !== undefined) {
    throw filesystemInvalidRequest(`unsupported publish field "${invalidKey}"`, "publish");
  }
  const flowId = value.flowId;
  if (typeof flowId !== "string" || !FLOW_ID_PATTERN.test(flowId)) {
    throw filesystemInvalidRequest("publish.flowId must be a bounded flow identifier", "publish");
  }
  return flowId;
}

function normalizeLookupInput(
  params: Readonly<Record<string, unknown>>,
): NormalizedReadBatchLookupRequest {
  const allowed = ["ref", "flowId", "covers"];
  const invalidKey = Object.keys(params).find((key) => !allowed.includes(key));
  if (invalidKey !== undefined) {
    throw filesystemInvalidRequest(`unsupported request field "${invalidKey}"`, invalidKey);
  }
  const ref = params.ref;
  if (typeof ref !== "string" || !READ_BATCH_REF_PATTERN.test(ref)) {
    throw filesystemInvalidRequest("ref must be a read_batch evidence reference", "ref");
  }
  const flowId = params.flowId;
  if (flowId !== undefined) {
    if (typeof flowId !== "string" || !FLOW_ID_PATTERN.test(flowId)) {
      throw filesystemInvalidRequest("flowId must be a bounded flow identifier", "flowId");
    }
  }
  const covers = params.covers;
  let normalizedCovers: readonly string[] | undefined;
  if (covers !== undefined) {
    if (
      !Array.isArray(covers) ||
      covers.length > READ_BATCH_MAX_COVERS ||
      !covers.every(
        (cover) =>
          typeof cover === "string" &&
          cover.length > 0 &&
          cover.length <= READ_BATCH_MAX_COVER_LENGTH,
      )
    ) {
      throw filesystemInvalidRequest(
        `covers must contain at most ${READ_BATCH_MAX_COVERS} bounded strings`,
        "covers",
      );
    }
    normalizedCovers = Object.freeze(
      covers.filter((cover): cover is string => typeof cover === "string"),
    );
  }
  return {
    kind: "lookup",
    ref,
    ...(flowId === undefined ? {} : { flowId }),
    ...(normalizedCovers === undefined ? {} : { covers: normalizedCovers }),
  };
}

function validateReadBatchRequest(rawParams: ReadBatchInput): {
  readonly request: NormalizedReadBatchRequest;
  readonly coercions: readonly string[];
} {
  if (!isRecord(rawParams)) {
    throw filesystemInvalidRequest("request must be an object", "paths");
  }
  const coercions: string[] = [];
  const params = stripNullProperties(rawParams, coercions, READ_BATCH_INPUT_KEYS) as ReadBatchInput;
  if (params.ref !== undefined) {
    return { request: normalizeLookupInput(params), coercions };
  }
  const invalidKey = Object.keys(params).find((key) => key !== "paths" && key !== "publish");
  if (invalidKey !== undefined) {
    throw filesystemInvalidRequest(`unsupported request field "${invalidKey}"`, invalidKey);
  }
  if (!Array.isArray(params.paths) || params.paths.length === 0) {
    throw filesystemInvalidRequest("paths must contain at least one entry", "paths");
  }
  if (params.paths.length > READ_BATCH_MAX_PATHS) {
    throw filesystemInvalidRequest(
      `paths must contain at most ${READ_BATCH_MAX_PATHS} entries`,
      "paths",
    );
  }
  const inputs = params.paths.map(normalizePathInput);
  validateNoOverlappingRanges(inputs);
  const publishFlowId =
    params.publish === undefined ? undefined : normalizePublishInput(params.publish);
  return {
    request: {
      kind: "execute",
      paths: inputs,
      ...(publishFlowId === undefined ? {} : { publishFlowId }),
    },
    coercions,
  };
}

function validateNoOverlappingRanges(inputs: ReadonlyArray<NormalizedReadBatchPath>): void {
  const intervals = new Map<string, Array<{ readonly start: number; readonly end: number }>>();
  for (const input of inputs) {
    const start = input.range?.offset ?? 1;
    const end =
      input.range?.limit === undefined ? Number.POSITIVE_INFINITY : start + input.range.limit - 1;
    const existing = intervals.get(input.path) ?? [];
    for (const prior of existing) {
      if (prior.start <= end && start <= prior.end) {
        throw filesystemInvalidRequest(
          `duplicate or overlapping range for path "${input.path}"`,
          "paths",
        );
      }
    }
    existing.push({ start, end });
    intervals.set(input.path, existing);
  }
}

function normalizedRangeKey(range: ReadBatchRange | undefined): string {
  return range === undefined ? "all" : JSON.stringify(range);
}

function readReference(
  root: string,
  path: string,
  range: ReadBatchRange | undefined,
  contentHash: string,
): string {
  const hash = createHash("sha256")
    .update("read-batch-v1", "utf8")
    .update("\0", "utf8")
    .update(root, "utf8")
    .update("\0", "utf8")
    .update(path, "utf8")
    .update("\0", "utf8")
    .update(normalizedRangeKey(range), "utf8")
    .update("\0", "utf8")
    .update(contentHash, "utf8")
    .digest("hex");
  return `${READ_BATCH_REF_PREFIX}${hash.slice(0, 24)}`;
}

function cacheScope(): string {
  const context = readProjectCommandOrchestrationContext();
  const flowId = effectiveOrchestrationFlowId(context);
  return flowId !== undefined ? `flow:${flowId}` : "session";
}

interface ReadBatchScopeMetadata {
  readonly scope: "session" | "flow";
  readonly flowId?: string;
}

function scopeMetadata(scope: string): ReadBatchScopeMetadata {
  return scope.startsWith("flow:")
    ? { scope: "flow", flowId: scope.slice("flow:".length) }
    : { scope: "session" };
}

function envelopeScope(scope: string): SharedEvidenceScope {
  return scope.startsWith("flow:") ? "flow" : "session";
}

function cacheKey(
  scope: string,
  root: string,
  path: string,
  range: ReadBatchRange | undefined,
): string {
  return JSON.stringify([scope, root, path, normalizedRangeKey(range)]);
}

function trimCache(cache: Map<string, PreviousRead>): void {
  while (cache.size > READ_BATCH_MAX_CACHE_ENTRIES) {
    const first = cache.keys().next().value;
    if (first === undefined) return;
    cache.delete(first);
  }
}

function outputContent(
  bytes: Buffer,
  range: ReadBatchRange | undefined,
): { readonly content: string; readonly output: ReadBatchOutput } {
  const text = bytes.toString("utf8");
  const lines = text.split("\n");
  const start = (range?.offset ?? 1) - 1;
  if (start >= lines.length) {
    throw filesystemInvalidRequest("range.offset is beyond the end of the file", "range.offset");
  }
  const end =
    range?.limit === undefined ? lines.length : Math.min(start + range.limit, lines.length);
  const selected = lines.slice(start, end).join("\n");
  const selectedBytes = Buffer.from(selected, "utf8");
  const truncated = selectedBytes.byteLength > READ_BATCH_MAX_CONTENT_BYTES;
  return {
    content: decodeUtf8Prefix(selectedBytes, READ_BATCH_MAX_CONTENT_BYTES, truncated),
    output: {
      truncated,
      totalBytes: bytes.byteLength,
      totalLines: lines.length,
    },
  };
}

function pathFailure(options: ReadBatchPathFailureOptions): ReadBatchPathError {
  return {
    code: options.code,
    message: options.message,
    ...(options.category === undefined ? {} : { category: options.category }),
    ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
    ...(options.executed === undefined ? {} : { executed: options.executed }),
    ...(options.ruleKind === undefined ? {} : { ruleKind: options.ruleKind }),
    ...(options.authorizedRoots === undefined
      ? {}
      : { authorizedRoots: Object.freeze([...options.authorizedRoots].slice(0, 8)) }),
  };
}

function pathFailureFromError(
  error: unknown,
  fallback: ReadBatchPathFailureOptions,
): ReadBatchPathError {
  if (!(error instanceof FilesystemToolError)) return pathFailure(fallback);
  const details = isRecord(error.details) ? error.details : undefined;
  const ruleKind = typeof details?.ruleKind === "string" ? details.ruleKind : undefined;
  const authorizedRoots = Array.isArray(details?.authorizedRoots)
    ? details.authorizedRoots.filter((root): root is string => typeof root === "string").slice(0, 8)
    : undefined;
  return pathFailure({
    code: error.contract.code,
    message: error.contract.explanation,
    category: error.contract.category,
    retryable: error.contract.retryable,
    executed: error.contract.executed,
    ...(ruleKind === undefined ? {} : { ruleKind }),
    ...(authorizedRoots === undefined ? {} : { authorizedRoots }),
  });
}

interface ReadBatchAggregateBudget {
  returnedBytes: number;
  capped: boolean;
}

function aggregateLimitFailure(): ReadBatchPathError {
  return pathFailure({
    code: "aggregate-limit",
    message: "The aggregate batch read limit was reached; this path was not read.",
    category: "INVALID_REQUEST",
    retryable: false,
    executed: false,
  });
}

function readAuthorizationError(
  kind: AuthorizationErrorKind,
  request: FilesystemAuthorizationRequest,
  decision: PolicyAuthorization,
  loaded?: LoadedPolicy,
): FilesystemToolError {
  const prefix = `Tool call blocked by access policy: read_batch ${request.access} access to "${displayPath(request.path)}"`;
  if (kind === "cancelled") {
    return filesystemCancellationError(`${prefix}${BLOCKED_REASON_SUFFIXES.cancelled}`);
  }
  const suffix =
    kind === "denied"
      ? ` is denied by ${DENIED_POLICY_SCOPES[decision]} policy rule.`
      : BLOCKED_REASON_SUFFIXES[kind];
  const denialMetadata =
    kind === "denied" &&
    loaded !== undefined &&
    (decision === "deny-global" || decision === "deny-project")
      ? filesystemPolicyDenialMetadata(loaded, request.access, decision)
      : undefined;
  return filesystemError(
    `${prefix}${suffix}`,
    filesystemAuthorizationContract(kind),
    undefined,
    denialMetadata,
  );
}

interface ResolvedReadBatchRoot {
  readonly root: string;
  readonly cwd: string;
}

async function resolveRoot(
  cwd: string,
  fileSystem: ReadBatchFileSystem,
  gitExec: GitExec | undefined,
  signal: AbortSignal | undefined,
): Promise<ResolvedReadBatchRoot> {
  let canonicalCwd: string;
  try {
    canonicalCwd = await fileSystem.realpath(cwd);
  } catch {
    throw filesystemError(
      "Unable to resolve the active workspace",
      filesystemContract({
        code: "workspace-resolution-failure",
        category: "IMPLEMENTATION_FAILURE",
        explanation: "The active workspace could not be resolved.",
        retryable: true,
        executed: false,
      }),
    );
  }
  if (gitExec !== undefined) {
    try {
      return {
        root: (await resolveRepository(gitExec, canonicalCwd, signal)).root,
        cwd: canonicalCwd,
      };
    } catch {
      if (signal?.aborted) throw filesystemCancellationError("Batch read cancelled");
    }
  }
  return { root: canonicalCwd, cwd: canonicalCwd };
}

type ResolvedReadBatchPath =
  | { readonly path: string; readonly canonical: string }
  | { readonly path: string; readonly error: ReadBatchPathError };

type ReadBatchFileContents = { readonly bytes: Buffer } | { readonly error: ReadBatchPathError };

function readBatchPathResult(
  path: string,
  input: NormalizedReadBatchPath,
  error?: ReadBatchPathError,
): ReadBatchPathResult {
  return {
    path,
    ...(input.range === undefined ? {} : { range: input.range }),
    ...(error === undefined ? {} : { error }),
  };
}

async function resolveReadBatchPath(
  input: NormalizedReadBatchPath,
  root: string,
  cwd: string,
  fileSystem: ReadBatchFileSystem,
  signal: AbortSignal | undefined,
): Promise<ResolvedReadBatchPath> {
  let path = reportedPath(root, cwd, input.path);
  try {
    const requested = requestPath(input.path, cwd);
    const canonical = await canonicalExistingPath(requested, fileSystem);
    path = repositoryRelativePath(root, canonical) ?? "<outside-repository>";
    if (path === "<outside-repository>") {
      return {
        path,
        error: pathFailure({
          code: "outside-repository",
          message: "The requested path is outside the repository.",
          category: "INVALID_REQUEST",
          retryable: false,
          executed: false,
        }),
      };
    }
    return { path, canonical };
  } catch (error) {
    if (signal?.aborted) throw filesystemCancellationError("Batch read cancelled");
    return {
      path,
      error: pathFailureFromError(error, {
        code: "path-resolution-failure",
        message: "The requested file could not be resolved.",
        category: "IMPLEMENTATION_FAILURE",
        retryable: true,
        executed: false,
      }),
    };
  }
}

async function inspectReadBatchFile(
  canonical: string,
  fileSystem: ReadBatchFileSystem,
  signal: AbortSignal | undefined,
): Promise<ReadBatchPathError | undefined> {
  try {
    const stats = await fileSystem.lstat(canonical);
    if (!stats.isFile()) {
      return pathFailure({
        code: "not-regular-file",
        message: "The requested path is not a regular file.",
        category: "INVALID_REQUEST",
        retryable: false,
        executed: false,
      });
    }
    if (!Number.isFinite(stats.size) || stats.size > READ_BATCH_MAX_FILE_BYTES) {
      return pathFailure({
        code: "file-too-large",
        message: "The file exceeds the bounded batch read limit.",
        category: "INVALID_REQUEST",
        retryable: false,
        executed: false,
      });
    }
    return undefined;
  } catch (error) {
    if (signal?.aborted) throw filesystemCancellationError("Batch read cancelled");
    return pathFailureFromError(error, {
      code: "filesystem-inspection-failure",
      message: "The requested file could not be inspected.",
      category: "IMPLEMENTATION_FAILURE",
      retryable: true,
      executed: false,
    });
  }
}

async function authorizeReadBatchPath(
  canonical: string,
  loaded: LoadedPolicy,
  context: ReadBatchToolContext,
  policy: PolicyStore,
  signal: AbortSignal | undefined,
  observe: AuthorizationOutcomeObserver | undefined,
  retryTracker: AuthorizationRetryTracker | undefined,
): Promise<ReadBatchPathError | undefined> {
  try {
    await authorizeAndPersistFilesystemAccesses(
      [{ access: "read", path: canonical }],
      loaded,
      context,
      policy,
      signal,
      {
        promptText: ({ path: identity }) =>
          `Authorize read access for read_batch to ${displayPath(identity)}?`,
        error: (kind, request, decision, currentLoaded) =>
          readAuthorizationError(kind, request, decision, currentLoaded),
        observe,
        retryTracker,
      },
    );
    return undefined;
  } catch (error) {
    if (signal?.aborted) throw filesystemCancellationError("Batch read cancelled");
    return pathFailureFromError(error, {
      code: "policy-evaluation-failure",
      message: "Filesystem read access could not be authorized.",
      category: "POLICY_FAILURE",
      retryable: true,
      executed: false,
    });
  }
}

async function readReadBatchFile(
  canonical: string,
  fileSystem: ReadBatchFileSystem,
  signal: AbortSignal | undefined,
): Promise<ReadBatchFileContents> {
  let bytes: Buffer;
  try {
    bytes = await fileSystem.readFile(canonical);
  } catch (error) {
    if (signal?.aborted) throw filesystemCancellationError("Batch read cancelled");
    return {
      error: pathFailureFromError(error, {
        code: "read-failure",
        message: "The requested file could not be read.",
        category: "IMPLEMENTATION_FAILURE",
        retryable: true,
        executed: false,
      }),
    };
  }
  if (bytes.byteLength > READ_BATCH_MAX_FILE_BYTES) {
    return {
      error: pathFailure({
        code: "file-too-large",
        message: "The file exceeds the bounded batch read limit.",
        category: "INVALID_REQUEST",
        retryable: false,
        executed: false,
      }),
    };
  }
  return { bytes };
}

function finalizeReadBatchRead(
  input: NormalizedReadBatchPath,
  canonical: string,
  path: string,
  root: string,
  scope: string,
  bytes: Buffer,
  signal: AbortSignal | undefined,
  cache: Map<string, PreviousRead>,
): ReadBatchPathResult {
  let selected: { readonly content: string; readonly output: ReadBatchOutput };
  try {
    selected = outputContent(bytes, input.range);
  } catch (error) {
    if (signal?.aborted) throw filesystemCancellationError("Batch read cancelled");
    return readBatchPathResult(
      path,
      input,
      pathFailureFromError(error, {
        code: "invalid-range",
        message: "The requested line range is invalid for this file.",
        category: "INVALID_REQUEST",
        retryable: false,
        executed: false,
      }),
    );
  }

  const contentHash = createHash("sha256").update(bytes).digest("hex");
  if (input.range === undefined) recordObservedContent(canonical, contentHash);
  const key = cacheKey(scope, root, path, input.range);
  const previous = cache.get(key);
  if (previous?.evidence.contentHash === contentHash) {
    return {
      path,
      ...(input.range === undefined ? {} : { range: input.range }),
      unchanged: true,
      ref: previous.evidence.ref,
      contentHash,
    };
  }
  const ref = readReference(root, path, input.range, contentHash);
  cache.set(key, {
    evidence: Object.freeze({
      evidenceFormatVersion: EVIDENCE_ENVELOPE_FORMAT_VERSION,
      ref,
      producer: EVIDENCE_PRODUCER,
      kind: "read-batch" as const,
      scope: envelopeScope(scope),
      requestHash: sharedEvidenceRequestHash({
        root,
        path,
        range: normalizedRangeKey(input.range),
      }),
      contentHash,
      output: Object.freeze(selected.output),
    }),
  });
  trimCache(cache);
  return {
    path,
    ...(input.range === undefined ? {} : { range: input.range }),
    unchanged: false,
    ref,
    contentHash,
    content: selected.content,
    output: selected.output,
  };
}

async function readOne(
  input: NormalizedReadBatchPath,
  root: string,
  cwd: string,
  loaded: LoadedPolicy,
  context: ReadBatchToolContext,
  policy: PolicyStore,
  fileSystem: ReadBatchFileSystem,
  signal: AbortSignal | undefined,
  scope: string,
  cache: Map<string, PreviousRead>,
  observe: AuthorizationOutcomeObserver | undefined,
  retryTracker: AuthorizationRetryTracker | undefined,
  budget: ReadBatchAggregateBudget,
): Promise<ReadBatchPathResult> {
  const resolved = await resolveReadBatchPath(input, root, cwd, fileSystem, signal);
  if ("error" in resolved) return readBatchPathResult(resolved.path, input, resolved.error);

  const inspectionError = await inspectReadBatchFile(resolved.canonical, fileSystem, signal);
  if (inspectionError !== undefined) {
    return readBatchPathResult(resolved.path, input, inspectionError);
  }

  if (
    budget.capped ||
    budget.returnedBytes + READ_BATCH_MAX_CONTENT_BYTES > READ_BATCH_MAX_AGGREGATE_CONTENT_BYTES
  ) {
    budget.capped = true;
    return readBatchPathResult(resolved.path, input, aggregateLimitFailure());
  }

  const authorizationError = await authorizeReadBatchPath(
    resolved.canonical,
    loaded,
    context,
    policy,
    signal,
    observe,
    retryTracker,
  );
  if (authorizationError !== undefined) {
    return readBatchPathResult(resolved.path, input, authorizationError);
  }

  const contents = await readReadBatchFile(resolved.canonical, fileSystem, signal);
  if ("error" in contents) return readBatchPathResult(resolved.path, input, contents.error);

  const outcome = finalizeReadBatchRead(
    input,
    resolved.canonical,
    resolved.path,
    root,
    scope,
    contents.bytes,
    signal,
    cache,
  );
  if (outcome.content !== undefined) {
    budget.returnedBytes += Buffer.byteLength(outcome.content, "utf8");
  }
  return outcome;
}

function result(details: ReadBatchDetails): AgentToolResult<ReadBatchDetails> {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
    structuredContent: toJsonValue(details),
  };
}

function getSessionId(ctx: ReadBatchToolContext): string | undefined {
  const value = ctx.sessionManager?.getSessionId();
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requestedPathCount(params: ReadBatchInput): number {
  if (!isRecord(params) || !Array.isArray(params.paths)) return 0;
  return params.paths.length;
}

function classifyReadBatchFailure(error: unknown): ReadBatchInvocationReason {
  if (error instanceof FilesystemToolError) {
    if (error.contract.code === "cancelled") return "cancelled";
    if (error.contract.code === "invalid-request") return "invalid-request";
  }
  return "failed";
}

function lookupInvocationOutcomeMetadata(
  outcome: ReadEvidenceLookupOutcome,
): ReadBatchInvocationLookupMetadata {
  return outcome === "success"
    ? { attempted: true, success: true, outcome: "success" }
    : { attempted: true, success: false, failure: "not-found", outcome };
}

function lookupInvocationMetadata(
  outcome: ReadEvidenceLookupOutcome | undefined,
): ReadBatchInvocationLookupMetadata | undefined {
  if (outcome === undefined) return undefined;
  return lookupInvocationOutcomeMetadata(outcome);
}

function readBatchLookupCatchReason(
  classified: ReadBatchInvocationReason,
  lookupOutcome: ReadEvidenceLookupOutcome | undefined,
): ReadBatchInvocationReason {
  if (classified !== "failed" || lookupOutcome === undefined || lookupOutcome === "success") {
    return classified;
  }
  return "completed";
}

function readBatchLookupCatchMetadata(
  lookupOutcome: ReadEvidenceLookupOutcome | undefined,
): ReadBatchInvocationLookupMetadata {
  if (lookupOutcome === undefined) {
    return { attempted: true, success: false, failure: "lookup-failure" };
  }
  return lookupInvocationOutcomeMetadata(lookupOutcome);
}

function readBatchInvocationItem(pathResult: ReadBatchPathResult): ReadBatchInvocationItem {
  const content = pathResult.content;
  const output = pathResult.output;
  const errorCode = pathResult.error?.code;
  return {
    pathHash: createHash("sha256").update(pathResult.path, "utf8").digest("hex"),
    pathLength: pathResult.path.length,
    ...(pathResult.range === undefined ? {} : { range: pathResult.range }),
    unchanged: pathResult.unchanged === true,
    truncated: output?.truncated === true,
    totalBytes: output?.totalBytes ?? 0,
    totalLines: output?.totalLines ?? 0,
    contentBytes: content === undefined ? 0 : Buffer.byteLength(content, "utf8"),
    ...(pathResult.ref === undefined ? {} : { ref: pathResult.ref }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function readBatchInvocationAggregate(details: ReadBatchDetails): ReadBatchInvocationAggregate {
  let contentBytes = 0;
  let totalBytes = 0;
  let totalLines = 0;
  let unchangedCount = 0;
  let truncatedCount = 0;
  let errorCount = 0;
  for (const item of details.results) {
    contentBytes += item.content === undefined ? 0 : Buffer.byteLength(item.content, "utf8");
    totalBytes += item.output?.totalBytes ?? 0;
    totalLines += item.output?.totalLines ?? 0;
    if (item.unchanged === true) unchangedCount += 1;
    if (item.output?.truncated === true) truncatedCount += 1;
    if (item.error !== undefined) errorCount += 1;
  }
  return {
    resultBytes: Buffer.byteLength(JSON.stringify(details), "utf8"),
    contentBytes,
    totalBytes,
    totalLines,
    unchangedCount,
    truncatedCount,
    errorCount,
  };
}

interface ReadBatchInvocationOptions {
  readonly reason: ReadBatchInvocationReason;
  readonly details?: ReadBatchDetails;
  readonly executed: boolean;
  readonly scopeInfo?: ReadBatchScopeMetadata;
  readonly requestedPaths?: number;
  readonly lookup?: ReadBatchInvocationLookupMetadata;
}

function readEvidencePublicationFailure(
  flowId: string,
  error: string,
): ReadBatchPublicationMetadata {
  return { scope: "flow", flowId, published: false, error };
}

function toInvocationPublication(
  value: ReadBatchPublicationMetadata | undefined,
): ReadBatchInvocationPublicationMetadata | undefined {
  if (value === undefined) return undefined;
  return {
    scope: value.scope,
    flowId: value.flowId,
    published: value.published,
    ...(value.error === undefined ? {} : { error: value.error }),
  };
}

function publishReadBatchEvidence(
  store: ReadEvidenceStore,
  root: string,
  flowId: string,
  results: ReadonlyArray<ReadBatchPathResult>,
  workspace: SharedEvidenceWorkspaceBlock | undefined,
): ReadBatchPublicationMetadata {
  const entries: ReadEvidenceEntry[] = [];
  for (const item of results) {
    if (
      item.error !== undefined ||
      item.content === undefined ||
      item.contentHash === undefined ||
      item.output === undefined
    ) {
      return {
        scope: "flow",
        flowId,
        published: false,
        error: "Published read evidence requires a fresh read of every requested path.",
      };
    }
    entries.push({
      path: item.path,
      ...(item.range === undefined ? {} : { range: item.range }),
      contentHash: item.contentHash,
      content: item.content,
      output: item.output,
    });
  }
  const record = createPublishedReadEvidenceRecord({
    root,
    flowId,
    entries,
    ...(workspace === undefined ? {} : { workspace }),
  });
  const recordBytes = readEvidenceRecordBytes(record);
  if (recordBytes === undefined || recordBytes > READ_EVIDENCE_MAX_RECORD_BYTES) {
    return readEvidencePublicationFailure(
      flowId,
      "Read evidence exceeds the published record size bound.",
    );
  }
  try {
    return store.publish(record, flowId)
      ? { scope: "flow", flowId, published: true, ref: record.ref }
      : readEvidencePublicationFailure(
          flowId,
          "Read evidence was not published to the requested flow.",
        );
  } catch {
    return readEvidencePublicationFailure(
      flowId,
      "Read evidence was not published to the requested flow.",
    );
  }
}

function createReadBatchToolWithDependencies(
  policy: PolicyStore,
  fileSystem: ReadBatchFileSystem,
  gitExec: GitExec | undefined,
  invocationRecorder: ReadBatchInvocationRecorder | undefined,
  repositoryStateReader: ProjectCommandRepositoryStateReader | undefined,
  authorizationOutcomeRecorder: AuthorizationOutcomeRecorder | undefined,
  authorizationRetryTracker: AuthorizationRetryTracker | undefined,
  readEvidenceStore: ReadEvidenceStore,
): ReadBatchToolDefinition {
  const cache = new Map<string, PreviousRead>();
  const schemaHash = hashToolParameters(readBatchParameters);
  return {
    name: "read_batch",
    label: "Batch read",
    description:
      "Read bounded repository-relative file ranges, or resolve previously published read evidence. Use paths for execution, ref for lookup, publish.flowId for authorized flow publication, and covers for lookup attribution.",
    promptSnippet: "Read files or resolve published evidence",
    annotations: { readOnlyHint: true },
    parameters: readBatchParameters,
    outputSchema: readBatchDetailsSchema,
    executionMode: "sequential",
    renderCall(args, theme) {
      const paths = Array.isArray(args?.paths) ? args.paths : [];
      const ref = typeof args?.ref === "string" ? args.ref : undefined;
      if (paths.length === 0 && ref !== undefined) {
        return renderCallLine(theme, "read_batch", [renderStringArgument(ref, theme)]);
      }
      const first = paths[0];
      const summary =
        first !== undefined && typeof first === "object" && first !== null && "path" in first
          ? renderStringArgument(first.path, theme)
          : theme.fg("error", "[invalid paths]");
      const suffix = paths.length > 1 ? theme.fg("muted", `+${paths.length - 1}`) : "";
      return renderCallLine(theme, "read_batch", [summary, suffix]);
    },
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const startedAt = performance.now();
      const sessionId = getSessionId(ctx);
      const observeState = invocationRecorder !== undefined && sessionId !== undefined;
      const orchestration = readProjectCommandOrchestrationContext();
      const authorizationObserver = createAuthorizationOutcomeObserver({
        surface: "filesystem",
        commandId: "read_batch",
        recorder: authorizationOutcomeRecorder,
        sessionId,
        toolCallId,
        mode: ctx.mode,
        flowId: effectiveOrchestrationFlowId(orchestration),
        attribution: orchestration,
      });
      let workspaceBlock: SharedEvidenceWorkspaceBlock | undefined;
      let recorded = false;
      const record = (options: ReadBatchInvocationOptions): void => {
        if (sessionId === undefined || recorded) return;
        recorded = true;
        const details = options.details;
        const scopeInfo = options.scopeInfo ?? { scope: "session" };
        const publication = toInvocationPublication(details?.publish);
        recordReadBatchInvocation(invocationRecorder, {
          sessionId,
          toolCallId,
          schemaHash,
          requestedPaths: options.requestedPaths ?? requestedPathCount(params),
          reason: options.reason,
          executed: options.executed,
          durationMs: performance.now() - startedAt,
          ...(details === undefined ? {} : { items: details.results.map(readBatchInvocationItem) }),
          ...(details === undefined ? {} : { aggregate: readBatchInvocationAggregate(details) }),
          scope: scopeInfo.scope,
          ...(scopeInfo.flowId === undefined ? {} : { flowId: scopeInfo.flowId }),
          ...(workspaceBlock === undefined ? {} : { repositoryState: workspaceBlock }),
          ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
          ...(orchestration.orchestrated && orchestration.role !== undefined
            ? { role: orchestration.role }
            : {}),
          ...(orchestration.orchestrated && orchestration.delegationId !== undefined
            ? { delegationId: orchestration.delegationId }
            : {}),
          ...(publication === undefined ? {} : { publication }),
        });
      };
      try {
        const { request, coercions } = validateReadBatchRequest(params);
        const requestSignal = signal ?? ctx.signal;
        if (request.kind === "lookup") {
          const requestedFlowId = request.flowId;
          const unauthorizedFlow =
            requestedFlowId !== undefined &&
            (orchestration.effectiveScope !== "flow" || orchestration.flowId !== requestedFlowId);
          const flowId = effectiveOrchestrationFlowId(orchestration);
          const scopeInfo = scopeMetadata(cacheScope());
          let lookupOutcome: ReadEvidenceLookupOutcome | undefined;
          let lookupRoot: ResolvedReadBatchRoot | undefined;
          let lookupLoaded: LoadedPolicy | undefined;
          const ensureLookupRoot = async (): Promise<ResolvedReadBatchRoot> => {
            if (lookupRoot === undefined) {
              lookupRoot = await resolveRoot(ctx.cwd, fileSystem, gitExec, requestSignal);
            }
            return lookupRoot;
          };
          const ensureLookupPolicy = async (): Promise<LoadedPolicy> => {
            if (lookupLoaded === undefined) {
              lookupLoaded = await loadFilesystemPolicyForRequest(policy, ctx.cwd, requestSignal);
            }
            return lookupLoaded;
          };
          const probePath = async (entry: ReadEvidenceEntry): Promise<ReadEvidencePathProbe> => {
            const resolvedRoot = await ensureLookupRoot();
            const loaded = await ensureLookupPolicy();
            const resolved = await resolveReadBatchPath(
              { path: entry.path, ...(entry.range === undefined ? {} : { range: entry.range }) },
              resolvedRoot.root,
              resolvedRoot.root,
              fileSystem,
              requestSignal,
            );
            if ("error" in resolved) return { status: "unreadable" };
            const inspectionError = await inspectReadBatchFile(
              resolved.canonical,
              fileSystem,
              requestSignal,
            );
            if (inspectionError !== undefined) return { status: "unreadable" };
            const authorizationError = await authorizeReadBatchPath(
              resolved.canonical,
              loaded,
              ctx,
              policy,
              requestSignal,
              authorizationObserver,
              authorizationRetryTracker,
            );
            if (authorizationError !== undefined) return { status: "unauthorized" };
            const contents = await readReadBatchFile(resolved.canonical, fileSystem, requestSignal);
            if ("error" in contents) return { status: "unreadable" };
            const currentHash = createHash("sha256").update(contents.bytes).digest("hex");
            if (currentHash !== entry.contentHash) return { status: "changed" };
            try {
              const derived = outputContent(contents.bytes, entry.range);
              return {
                status: "unchanged",
                content: derived.content,
                output: derived.output,
              };
            } catch {
              return { status: "changed" };
            }
          };
          const observeWorkspace = async (): Promise<SharedEvidenceWorkspaceBlock | undefined> => {
            if (repositoryStateReader === undefined) return undefined;
            const resolvedRoot = await ensureLookupRoot();
            const state = await repositoryStateReader(resolvedRoot.cwd, requestSignal).catch(
              () => undefined,
            );
            return Object.freeze({
              repositoryId: sharedRepositoryId(resolvedRoot.root),
              head: state?.head ?? null,
              dirtyDigest: state?.dirtyFilesDigest ?? null,
              status: state === undefined ? "degraded" : "readable",
            });
          };
          try {
            const lookupResult = await resolveReadEvidenceLookup({
              store: readEvidenceStore,
              ref: request.ref,
              requestedFlowId,
              flowId,
              covers: request.covers,
              unauthorizedFlow,
              probePath,
              observeWorkspace,
              onOutcome: (outcome) => {
                lookupOutcome = outcome;
              },
            });
            const outcome = result({
              results: Object.freeze([]),
              lookup: lookupResult,
              ...(coercions.length === 0 ? {} : { coercions: [...coercions] }),
            });
            record({
              reason: "completed",
              details: outcome.details,
              executed: false,
              scopeInfo,
              requestedPaths: 0,
              lookup: lookupInvocationMetadata(lookupOutcome),
            });
            return outcome;
          } catch (error) {
            const classified = classifyReadBatchFailure(error);
            record({
              reason: readBatchLookupCatchReason(classified, lookupOutcome),
              executed: false,
              scopeInfo,
              requestedPaths: 0,
              lookup: readBatchLookupCatchMetadata(lookupOutcome),
            });
            throw error;
          }
        }
        const inputs = request.paths;
        if (requestSignal?.aborted) throw filesystemCancellationError("Batch read cancelled");
        const resolvedRoot = await resolveRoot(ctx.cwd, fileSystem, gitExec, requestSignal);
        const root = resolvedRoot.root;
        const canonicalCwd = resolvedRoot.cwd;
        if (requestSignal?.aborted) throw filesystemCancellationError("Batch read cancelled");
        const shouldObserveState = observeState || request.publishFlowId !== undefined;
        const observedStatePromise =
          shouldObserveState && repositoryStateReader !== undefined
            ? repositoryStateReader(canonicalCwd, requestSignal).catch(() => undefined)
            : Promise.resolve(undefined);
        let loaded: LoadedPolicy;
        try {
          loaded = await loadFilesystemPolicyForRequest(policy, ctx.cwd, requestSignal);
        } catch (error) {
          if (requestSignal?.aborted) throw filesystemCancellationError("Batch read cancelled");
          const failure = pathFailureFromError(error, {
            code: "policy-load-failure",
            message: "Filesystem access policy could not be loaded.",
            category: "POLICY_FAILURE",
            retryable: true,
            executed: false,
          });
          const outcome = result({
            results: inputs.map((input) => ({
              path: reportedPath(root, canonicalCwd, input.path),
              ...(input.range === undefined ? {} : { range: input.range }),
              error: failure,
            })),
            ...(request.publishFlowId === undefined
              ? {}
              : {
                  publish: readEvidencePublicationFailure(
                    request.publishFlowId,
                    "Read evidence was not published because the filesystem policy could not be loaded.",
                  ),
                }),
          });
          record({ reason: "completed", details: outcome.details, executed: false });
          return outcome;
        }
        if (shouldObserveState) {
          const observedState = await observedStatePromise;
          workspaceBlock = Object.freeze({
            repositoryId: sharedRepositoryId(root),
            head: observedState?.head ?? null,
            dirtyDigest: observedState?.dirtyFilesDigest ?? null,
            status: observedState === undefined ? "degraded" : "readable",
          });
        }
        const scope = cacheScope();
        const scopeInfo = scopeMetadata(scope);
        const results: ReadBatchPathResult[] = [];
        const budget: ReadBatchAggregateBudget = { returnedBytes: 0, capped: false };
        let firstSkippedIndex: number | undefined;
        const collect = async (index: number): Promise<void> => {
          if (index >= inputs.length) return;
          if (requestSignal?.aborted) throw filesystemCancellationError("Batch read cancelled");
          const input = inputs[index];
          if (input === undefined) return;
          if (budget.capped) {
            results.push(
              readBatchPathResult(
                reportedPath(root, canonicalCwd, input.path),
                input,
                aggregateLimitFailure(),
              ),
            );
          } else {
            const wasCapped = budget.capped;
            results.push(
              await readOne(
                input,
                root,
                canonicalCwd,
                loaded,
                ctx,
                policy,
                fileSystem,
                requestSignal,
                scope,
                cache,
                authorizationObserver,
                authorizationRetryTracker,
                budget,
              ),
            );
            if (!wasCapped && budget.capped) firstSkippedIndex = index;
          }
          await collect(index + 1);
        };
        await collect(0);
        if (requestSignal?.aborted) throw filesystemCancellationError("Batch read cancelled");
        const continuation =
          firstSkippedIndex === undefined
            ? undefined
            : { nextIndex: firstSkippedIndex, totalPaths: inputs.length };
        let details: ReadBatchDetails = {
          results: Object.freeze(results),
          ...(continuation === undefined ? {} : { continuation }),
          ...(coercions.length === 0 ? {} : { coercions: [...coercions] }),
        };
        if (request.publishFlowId !== undefined) {
          details = {
            ...details,
            publish: publishReadBatchEvidence(
              readEvidenceStore,
              root,
              request.publishFlowId,
              results,
              workspaceBlock,
            ),
          };
        }
        const outcome = result(details);
        record({
          reason: "completed",
          details: outcome.details,
          executed: true,
          scopeInfo,
          requestedPaths: inputs.length,
        });
        return outcome;
      } catch (error) {
        record({ reason: classifyReadBatchFailure(error), executed: false });
        throw error;
      }
    },
  };
}

export function createReadBatchTool(
  gitExec?: GitExec,
  options?: ReadBatchToolOptions,
): ReadBatchToolDefinition {
  return createReadBatchToolWithDependencies(
    createPolicyStore(),
    createNodeFileSystem(),
    gitExec,
    options?.invocationRecorder,
    options?.repositoryStateReader ??
      (gitExec === undefined ? undefined : createProjectCommandRepositoryStateReader(gitExec)),
    options?.authorizationOutcomeRecorder,
    options?.authorizationRetryTracker,
    createReadEvidenceStore(),
  );
}

export function createReadBatchToolForTesting(
  options: ReadBatchToolTestOptions,
): ReadBatchToolDefinition {
  const fileSystem = createFileSystem(options);
  return createReadBatchToolWithDependencies(
    requirePolicy(options, fileSystem),
    fileSystem,
    options.gitExec,
    options.invocationRecorder,
    options.repositoryStateReader,
    options.authorizationOutcomeRecorder,
    options.authorizationRetryTracker,
    options.readEvidenceStore ?? createReadEvidenceStore(),
  );
}
