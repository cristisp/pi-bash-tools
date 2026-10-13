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

import { sharedRepositoryId, type SharedEvidenceWorkspaceBlock } from "../../evidence/envelope.ts";
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
import { toJsonValue } from "../value-validation.ts";
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

const READ_BATCH_MAX_PATHS = 32;
const READ_BATCH_MAX_PATH_LENGTH = 4_096;
const READ_BATCH_MAX_OFFSET = 1_000_000;
const READ_BATCH_MAX_RANGE_LINES = 2_000;
const READ_BATCH_MAX_CONTENT_BYTES = 64 * 1024;
const READ_BATCH_MAX_AGGREGATE_CONTENT_BYTES = 256 * 1024;
const READ_BATCH_MAX_FILE_BYTES = 8 * 1024 * 1024;
const READ_BATCH_MAX_CACHE_ENTRIES = 512;
const READ_BATCH_INPUT_KEYS = new Set(["paths"]);

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

const readBatchParameters = Type.Object(
  {
    paths: Type.Optional(
      Type.Union([
        Type.Array(readBatchPathParameters, {
          minItems: 1,
          maxItems: READ_BATCH_MAX_PATHS,
          description: "One or more repository-relative files to read.",
        }),
        Type.Null(),
      ]),
    ),
  },
  {
    additionalProperties: false,
    description:
      "One or more repository-relative files to read, each with an optional bounded line range. Explicit null on optional fields is treated as omitted, and invalid combinations are rejected at runtime.",
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
  readonly contentHash?: string;
  readonly content?: string;
  readonly output?: ReadBatchOutput;
  readonly error?: ReadBatchPathError;
}

export interface ReadBatchContinuation {
  readonly nextIndex: number;
  readonly totalPaths: number;
}

export interface ReadBatchDetails {
  readonly results: readonly ReadBatchPathResult[];
  readonly continuation?: ReadBatchContinuation;
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
    contentHash: Type.Optional(
      Type.String({ description: "Lowercase SHA-256 digest of the full file bytes." }),
    ),
    content: Type.Optional(Type.String({ description: "Bounded file text." })),
    output: Type.Optional(readBatchOutputBlockSchema),
    error: Type.Optional(readBatchPathErrorSchema),
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
    coercions: Type.Optional(
      Type.Array(Type.String(), {
        description: "Descriptions of request fields normalized or rejected up front.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description: "Bounded batch read payload, also returned as the model-facing JSON text.",
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

function validateReadBatchRequest(rawParams: ReadBatchInput): {
  readonly request: NormalizedReadBatchExecuteRequest;
  readonly coercions: readonly string[];
} {
  if (!isRecord(rawParams)) {
    throw filesystemInvalidRequest("request must be an object", "paths");
  }
  const coercions: string[] = [];
  const params = stripNullProperties(rawParams, coercions, READ_BATCH_INPUT_KEYS) as ReadBatchInput;
  const invalidKey = Object.keys(params).find((key) => key !== "paths");
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
  return { request: { kind: "execute", paths: inputs }, coercions };
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

function cacheKey(
  scope: string,
  root: string,
  path: string,
  range: ReadBatchRange | undefined,
): string {
  return JSON.stringify([scope, root, path, normalizedRangeKey(range)]);
}

function trimCache(cache: Map<string, string>): void {
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
  cache: Map<string, string>,
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
  const previousHash = cache.get(key);
  if (previousHash === contentHash) {
    return {
      path,
      ...(input.range === undefined ? {} : { range: input.range }),
      unchanged: true,
      contentHash,
    };
  }
  cache.set(key, contentHash);
  trimCache(cache);
  return {
    path,
    ...(input.range === undefined ? {} : { range: input.range }),
    unchanged: false,
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
  cache: Map<string, string>,
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
}

function createReadBatchToolWithDependencies(
  policy: PolicyStore,
  fileSystem: ReadBatchFileSystem,
  gitExec: GitExec | undefined,
  invocationRecorder: ReadBatchInvocationRecorder | undefined,
  repositoryStateReader: ProjectCommandRepositoryStateReader | undefined,
  authorizationOutcomeRecorder: AuthorizationOutcomeRecorder | undefined,
  authorizationRetryTracker: AuthorizationRetryTracker | undefined,
): ReadBatchToolDefinition {
  const cache = new Map<string, string>();
  const schemaHash = hashToolParameters(readBatchParameters);
  return {
    name: "read_batch",
    label: "Batch read",
    description:
      "Read one or more repository-relative files with optional bounded line ranges. Fetch known files once, and use bounded ranges for large files instead of repeated whole-file reads.",
    promptSnippet: "Read bounded file ranges in one call",
    annotations: { readOnlyHint: true },
    parameters: readBatchParameters,
    outputSchema: readBatchDetailsSchema,
    executionMode: "sequential",
    renderCall(args, theme) {
      const paths = Array.isArray(args?.paths) ? args.paths : [];
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
          ...(orchestration.orchestrated && orchestration.role !== undefined
            ? { role: orchestration.role }
            : {}),
          ...(orchestration.orchestrated && orchestration.delegationId !== undefined
            ? { delegationId: orchestration.delegationId }
            : {}),
        });
      };
      try {
        const { request, coercions } = validateReadBatchRequest(params);
        const requestSignal = signal ?? ctx.signal;
        const inputs = request.paths;
        if (requestSignal?.aborted) throw filesystemCancellationError("Batch read cancelled");
        const resolvedRoot = await resolveRoot(ctx.cwd, fileSystem, gitExec, requestSignal);
        const root = resolvedRoot.root;
        const canonicalCwd = resolvedRoot.cwd;
        if (requestSignal?.aborted) throw filesystemCancellationError("Batch read cancelled");
        const shouldObserveState = observeState;
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
        const details: ReadBatchDetails = {
          results: Object.freeze(results),
          ...(continuation === undefined ? {} : { continuation }),
          ...(coercions.length === 0 ? {} : { coercions: [...coercions] }),
        };
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
  );
}
