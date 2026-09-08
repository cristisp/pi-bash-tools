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
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

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
import { readProjectCommandOrchestrationContext } from "../project-command/orchestration.ts";
import { decodeUtf8Prefix } from "../truncation.ts";
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
import { canonicalExistingPath, requestPath } from "./paths.ts";

const READ_BATCH_MAX_PATHS = 32;
const READ_BATCH_MAX_PATH_LENGTH = 4_096;
const READ_BATCH_MAX_OFFSET = 1_000_000;
const READ_BATCH_MAX_RANGE_LINES = 2_000;
const READ_BATCH_MAX_CONTENT_BYTES = 64 * 1024;
const READ_BATCH_MAX_FILE_BYTES = 8 * 1024 * 1024;
const READ_BATCH_MAX_CACHE_ENTRIES = 512;
const READ_BATCH_REF_PREFIX = "rr_";

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
  { additionalProperties: false },
);

const readBatchPathParameters = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      maxLength: READ_BATCH_MAX_PATH_LENGTH,
      description: "Path to a repository file",
    }),
    range: Type.Optional(readBatchRangeParameters),
  },
  { additionalProperties: false },
);

const readBatchParameters = Type.Object(
  {
    paths: Type.Array(readBatchPathParameters, {
      minItems: 1,
      maxItems: READ_BATCH_MAX_PATHS,
      description: "Repository files to read, each with an optional line range",
    }),
  },
  { additionalProperties: false },
);

type ReadBatchInput = Static<typeof readBatchParameters>;

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
  readonly content?: string;
  readonly output?: ReadBatchOutput;
  readonly error?: ReadBatchPathError;
}

export interface ReadBatchDetails {
  readonly results: readonly ReadBatchPathResult[];
}

export type ReadBatchToolContext = FilesystemAuthorizationContext;

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
> & { execute: ReadBatchExecute };

interface NormalizedReadBatchPath {
  readonly path: string;
  readonly range?: ReadBatchRange;
}

interface PreviousRead {
  readonly contentHash: string;
  readonly ref: string;
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

function validateInput(params: ReadBatchInput): ReadonlyArray<NormalizedReadBatchPath> {
  if (!isRecord(params)) {
    throw filesystemInvalidRequest("request must be an object", "paths");
  }
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
  return params.paths.map(normalizePathInput);
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
  return context.effectiveScope === "flow" && context.flowId !== undefined
    ? `flow:${context.flowId}`
    : "session";
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
  const key = cacheKey(scope, root, path, input.range);
  const previous = cache.get(key);
  if (previous?.contentHash === contentHash) {
    return {
      path,
      ...(input.range === undefined ? {} : { range: input.range }),
      unchanged: true,
      ref: previous.ref,
    };
  }
  const ref = readReference(root, path, input.range, contentHash);
  cache.set(key, { contentHash, ref });
  trimCache(cache);
  return {
    path,
    ...(input.range === undefined ? {} : { range: input.range }),
    unchanged: false,
    ref,
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
): Promise<ReadBatchPathResult> {
  const resolved = await resolveReadBatchPath(input, root, cwd, fileSystem, signal);
  if ("error" in resolved) return readBatchPathResult(resolved.path, input, resolved.error);

  const inspectionError = await inspectReadBatchFile(resolved.canonical, fileSystem, signal);
  if (inspectionError !== undefined) {
    return readBatchPathResult(resolved.path, input, inspectionError);
  }

  const authorizationError = await authorizeReadBatchPath(
    resolved.canonical,
    loaded,
    context,
    policy,
    signal,
  );
  if (authorizationError !== undefined) {
    return readBatchPathResult(resolved.path, input, authorizationError);
  }

  const contents = await readReadBatchFile(resolved.canonical, fileSystem, signal);
  if ("error" in contents) return readBatchPathResult(resolved.path, input, contents.error);

  return finalizeReadBatchRead(input, resolved.path, root, scope, contents.bytes, signal, cache);
}

function result(details: ReadBatchDetails): AgentToolResult<ReadBatchDetails> {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  };
}

function createReadBatchToolWithDependencies(
  policy: PolicyStore,
  fileSystem: ReadBatchFileSystem,
  gitExec: GitExec | undefined,
): ReadBatchToolDefinition {
  const cache = new Map<string, PreviousRead>();
  return {
    name: "read_batch",
    label: "Batch read",
    description:
      "Read bounded repository-relative file ranges in one request, returning per-path errors and stable content references for unchanged repeats.",
    promptSnippet: "Read multiple repository files with optional line ranges",
    parameters: readBatchParameters,
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
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const inputs = validateInput(params);
      const requestSignal = signal ?? ctx.signal;
      if (requestSignal?.aborted) throw filesystemCancellationError("Batch read cancelled");
      const resolvedRoot = await resolveRoot(ctx.cwd, fileSystem, gitExec, requestSignal);
      const root = resolvedRoot.root;
      const canonicalCwd = resolvedRoot.cwd;
      if (requestSignal?.aborted) throw filesystemCancellationError("Batch read cancelled");
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
        return result({
          results: inputs.map((input) => ({
            path: reportedPath(root, canonicalCwd, input.path),
            ...(input.range === undefined ? {} : { range: input.range }),
            error: failure,
          })),
        });
      }
      const scope = cacheScope();
      const results: ReadBatchPathResult[] = [];
      const collect = async (index: number): Promise<void> => {
        if (index >= inputs.length) return;
        if (requestSignal?.aborted) throw filesystemCancellationError("Batch read cancelled");
        const input = inputs[index];
        if (input === undefined) return;
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
          ),
        );
        await collect(index + 1);
      };
      await collect(0);
      if (requestSignal?.aborted) throw filesystemCancellationError("Batch read cancelled");
      return result({ results: Object.freeze(results) });
    },
  };
}

export function createReadBatchTool(gitExec?: GitExec): ReadBatchToolDefinition {
  return createReadBatchToolWithDependencies(createPolicyStore(), createNodeFileSystem(), gitExec);
}

export function createReadBatchToolForTesting(
  options: ReadBatchToolTestOptions,
): ReadBatchToolDefinition {
  const fileSystem = createFileSystem(options);
  return createReadBatchToolWithDependencies(
    requirePolicy(options, fileSystem),
    fileSystem,
    options.gitExec,
  );
}
