import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Type } from "typebox";

import { hashToolParameters } from "../../../observability/canonical-json.ts";
import { booleanInputSchema } from "../../boolean.ts";
import { renderCallLine, renderStringArgument } from "../../call-render.ts";
import {
  gitCancellationError,
  invalidGitRequest,
  invalidGitRequestShape,
  normalizeGitBoolean,
  runGit,
  validateGitRequestKeys,
  type GitExec,
} from "../execution.ts";
import { observeGitInvocation, type GitInvocationObservationOptions } from "../invocation.ts";
import {
  MAX_CONTENT_BYTES,
  makeStructuredToolResult,
  MAX_RECORDS,
  parseStatus,
  truncateUtf8,
  validateIntegerLimit,
} from "../output.ts";
import { resolvePath, resolvePaths, resolveRepository } from "../repository.ts";
import type { GitStatusEntry } from "../status/output.ts";
import { defineGitTool, type GitToolDefinition } from "../tool.ts";
import {
  createGitDiffSummaryCache,
  stateKey,
  type GitDiffSummaryCache,
  type GitDiffSummaryCacheClaim,
  type GitDiffSummaryCacheState,
} from "./cache.ts";
import type {
  GitDiffOutput,
  GitDiffPatchOutput,
  GitDiffSummaryOutput,
  GitDiffSummaryUnchangedOutput,
} from "./output.ts";
import { gitDiffOutputSchema } from "./output.ts";
import { createGitDiffSummary } from "./summary.ts";

interface GitDiffPreviousSummaryEntry {
  readonly digest: string;
  readonly entryCount: number;
  readonly head: string;
  readonly dirtyFilesDigest: string;
  readonly output: Pick<GitDiffSummaryOutput["output"], "totalBytes" | "totalLines" | "truncated">;
}

export const DEFAULT_GIT_DIFF_MAX_BYTES = 16 * 1024;

export interface GitDiffToolOptions {
  readonly summaryCache?: GitDiffSummaryCache;
  readonly invocationObservation?: GitInvocationObservationOptions;
}

const stagedSchema = Type.Optional(booleanInputSchema);
const mode = Type.Optional(
  Type.Union([Type.Literal("summary"), Type.Literal("patch")], {
    description: 'Response mode. Defaults to "summary".',
  }),
);
const maxBytes = Type.Optional(
  Type.Integer({
    minimum: 1,
    maximum: MAX_CONTENT_BYTES,
    description: `Maximum response bytes. Defaults to ${DEFAULT_GIT_DIFF_MAX_BYTES}.`,
  }),
);
const gitDiffParameters = Type.Object(
  {
    mode,
    path: Type.Optional(
      Type.String({
        description: 'Legacy single workspace-relative path. For new calls, use paths: ["file"].',
      }),
    ),
    paths: Type.Optional(
      Type.Array(Type.String(), {
        minItems: 1,
        description:
          'New calls should use paths: ["file"] for one path, or list multiple workspace-relative paths.',
      }),
    ),
    staged: stagedSchema,
    maxBytes,
  },
  {
    additionalProperties: false,
    description:
      "Omit path and paths to inspect the whole repository. Provide either path or paths, never both.",
  },
);

function diffArgs(stagedMode: boolean, paths: readonly string[]): string[] {
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--binary"];
  if (stagedMode) args.push("--cached");
  args.push("--", ...paths);
  return args;
}

function statusArgs(paths: readonly string[]): string[] {
  return ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...paths];
}

function diffStatArgs(stagedMode: boolean, paths: readonly string[]): string[] {
  const args = ["diff", "--no-ext-diff", "--no-textconv"];
  if (stagedMode) args.push("--cached");
  args.push("--stat", "--", ...paths);
  return args;
}

function diffRawArgs(stagedMode: boolean, paths: readonly string[]): string[] {
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--raw"];
  if (stagedMode) args.push("--cached");
  args.push("--", ...paths);
  return args;
}

function diffHunkArgs(stagedMode: boolean, paths: readonly string[]): string[] {
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--unified=0"];
  if (stagedMode) args.push("--cached");
  args.push("--", ...paths);
  return args;
}

async function hashUntrackedFiles(
  root: string,
  entries: readonly GitStatusEntry[],
): Promise<string> {
  const untracked = entries.filter((entry) => entry.worktreeStatus === "?");
  const contents = await Promise.all(
    untracked.map(async (entry) => {
      try {
        return { path: entry.path, content: await readFile(join(root, entry.path)) };
      } catch {
        return { path: entry.path, content: undefined };
      }
    }),
  );
  const hash = createHash("sha256");
  for (const entry of contents) {
    hash.update(entry.path, "utf8");
    hash.update("\\0", "utf8");
    if (entry.content === undefined) hash.update("missing", "utf8");
    else hash.update(entry.content);
    hash.update("\\0", "utf8");
  }
  return hash.digest("hex");
}

interface SummaryClaimWaitResult {
  readonly summary: GitDiffSummaryOutput | undefined;
  readonly claim: GitDiffSummaryCacheClaim | undefined;
  readonly cancelled: boolean;
}

function waitForSummaryClaim(
  cache: GitDiffSummaryCache,
  state: GitDiffSummaryCacheState,
  signal: AbortSignal | undefined,
): Promise<SummaryClaimWaitResult> {
  return new Promise((resolve) => {
    const poll = () => {
      if (signal?.aborted) {
        resolve({ summary: undefined, claim: undefined, cancelled: true });
        return;
      }
      const claim = cache.tryClaim(state);
      if (claim !== undefined) {
        const current = cache.get(state);
        if (current !== undefined) {
          cache.releaseClaim(claim);
          resolve({ summary: current, claim: undefined, cancelled: false });
          return;
        }
        resolve({ summary: undefined, claim, cancelled: false });
        return;
      }
      const current = cache.get(state);
      if (current !== undefined) {
        resolve({ summary: current, claim: undefined, cancelled: false });
        return;
      }
      if (signal?.aborted) {
        resolve({ summary: undefined, claim: undefined, cancelled: true });
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

type GitDiffRequestParams = {
  readonly mode?: "summary" | "patch";
  readonly path?: string;
  readonly paths?: readonly string[];
  readonly staged?: boolean | "true" | "false";
  readonly maxBytes?: number;
};

type GitRepository = Awaited<ReturnType<typeof resolveRepository>>;
type GitDiffRenderTheme = Parameters<typeof renderCallLine>[0];

type GitDiffRequest = {
  readonly responseMode: "summary" | "patch";
  readonly staged: boolean;
  readonly responseLimit: number;
};

type RawDiscovery = {
  readonly rawText: string;
  readonly untrackedDigest: string;
};

type RawDiscoveryFlights = Map<string, Promise<RawDiscovery>>;

function selectedStatus(entry: GitStatusEntry, stagedMode: boolean): string {
  return stagedMode ? entry.indexStatus : entry.worktreeStatus;
}

function shouldSelectStatus(status: string, stagedMode: boolean): boolean {
  return stagedMode ? status !== " " && status !== "?" : status !== " ";
}

function normalizeSelectedStatus(
  entry: GitStatusEntry,
  status: string,
  stagedMode: boolean,
): GitStatusEntry {
  const normalized = {
    path: entry.path,
    indexStatus: stagedMode ? status : " ",
    worktreeStatus: stagedMode ? " " : status,
  };
  return status === "R" || status === "C"
    ? entry.renamedFrom === undefined
      ? normalized
      : { ...normalized, renamedFrom: entry.renamedFrom }
    : normalized;
}

function selectStatusEntry(entry: GitStatusEntry, stagedMode: boolean): GitStatusEntry | undefined {
  const status = selectedStatus(entry, stagedMode);
  return shouldSelectStatus(status, stagedMode)
    ? normalizeSelectedStatus(entry, status, stagedMode)
    : undefined;
}

function selectStatus(entries: readonly GitStatusEntry[], stagedMode: boolean): GitStatusEntry[] {
  const selected: GitStatusEntry[] = [];
  for (const entry of entries) {
    const normalized = selectStatusEntry(entry, stagedMode);
    if (normalized !== undefined) selected.push(normalized);
  }
  return selected;
}

export function renderGitDiffCall(
  args: GitDiffRequestParams | undefined,
  theme: GitDiffRenderTheme,
) {
  const parts: string[] = [];
  if (args?.mode !== undefined) {
    parts.push(theme.fg("muted", `mode=${args.mode}`));
  } else {
    parts.push(theme.fg("muted", "mode=summary"));
  }
  if (args?.staged === true || args?.staged === "true") {
    parts.push(theme.fg("muted", "--staged"));
  }
  const paths =
    args === undefined
      ? []
      : args.paths !== undefined
        ? args.paths
        : args.path !== undefined
          ? [args.path]
          : [];
  if (paths.length === 0) {
    parts.push(theme.fg("muted", "(whole repository)"));
  } else {
    for (const path of paths) {
      parts.push(renderStringArgument(path, theme));
    }
  }
  parts.push(theme.fg("muted", `maxBytes=${args?.maxBytes ?? DEFAULT_GIT_DIFF_MAX_BYTES}`));
  return renderCallLine(theme, "git_diff", parts);
}

function isUnscopedPatchRequest(
  responseMode: "summary" | "patch",
  hasLegacyPath: boolean,
  hasPaths: boolean,
): boolean {
  return responseMode === "patch" && !hasLegacyPath && !hasPaths;
}

function normalizeGitDiffRequest(params: GitDiffRequestParams): GitDiffRequest {
  validateGitRequestKeys(
    params,
    ["mode", "path", "paths", "staged", "maxBytes"],
    '{ mode?: "summary" | "patch", path?: string, paths?: string[], staged?: boolean, maxBytes?: integer }',
  );
  const hasLegacyPath = params.path !== undefined;
  const hasPaths = params.paths !== undefined;
  if (hasLegacyPath && hasPaths) {
    throw invalidGitRequestShape("provide either path or paths, not both", "path");
  }
  const responseMode = params.mode ?? "summary";
  if (responseMode !== "summary" && responseMode !== "patch") {
    throw invalidGitRequest('mode must be either "summary" or "patch"', "mode");
  }
  if (isUnscopedPatchRequest(responseMode, hasLegacyPath, hasPaths)) {
    throw invalidGitRequestShape(
      'mode "patch" requires explicit path or paths; use the default summary to identify changed files, then request patch content for those paths',
      "paths",
    );
  }
  const staged = normalizeGitBoolean(params.staged, "staged") === true;
  const responseLimit = params.maxBytes ?? DEFAULT_GIT_DIFF_MAX_BYTES;
  validateIntegerLimit(responseLimit, 1, MAX_CONTENT_BYTES, "maxBytes");
  return { responseMode, staged, responseLimit };
}

async function resolveGitDiffPaths(
  repository: GitRepository,
  params: GitDiffRequestParams,
): Promise<string[]> {
  const hasLegacyPath = params.path !== undefined;
  const hasPaths = params.paths !== undefined;
  return hasPaths
    ? await resolvePaths(repository, params.paths)
    : hasLegacyPath
      ? [await resolvePath(repository, params.path)]
      : [];
}

async function executeGitDiffPatch(
  exec: GitExec,
  repository: GitRepository,
  signal: AbortSignal | undefined,
  staged: boolean,
  paths: readonly string[],
  responseLimit: number,
): Promise<GitDiffPatchOutput> {
  const result = await runGit(
    exec,
    diffArgs(staged, paths),
    repository.root,
    signal,
    "read Git diff",
  );
  const bounded = truncateUtf8(result.stdout, responseLimit);
  const message = bounded.output.truncated
    ? `INCOMPLETE git_diff patch: ${bounded.output.totalBytes} bytes were available and only the first ${responseLimit} bytes are returned. Follow up with an explicit scoped request using mode: "patch", paths: ["file"], and a larger maxBytes.`
    : undefined;
  return {
    mode: "patch",
    patch: bounded.text,
    output: bounded.output,
    ...(message === undefined ? {} : { message }),
  };
}

async function discoverRawState(
  exec: GitExec,
  repository: GitRepository,
  staged: boolean,
  paths: readonly string[],
  head: string,
  statusOutput: string,
  completeStatus: readonly GitStatusEntry[],
  rawDiscoveryFlights: RawDiscoveryFlights,
): Promise<RawDiscovery> {
  const rawDiscoveryKey = createHash("sha256")
    .update(
      JSON.stringify({
        repositoryRoot: repository.root,
        workingDirectory: repository.cwd,
        head,
        status: statusOutput,
        staged,
        paths,
      }),
      "utf8",
    )
    .digest("hex");
  let rawDiscovery = rawDiscoveryFlights.get(rawDiscoveryKey);
  if (rawDiscovery === undefined) {
    rawDiscovery = Promise.all([
      runGit(
        exec,
        diffRawArgs(staged, paths),
        repository.root,
        undefined,
        "read Git diff content state",
      ),
      hashUntrackedFiles(repository.root, completeStatus),
    ]).then(([rawResult, untrackedDigest]) => ({
      rawText: rawResult.stdout,
      untrackedDigest,
    }));
    rawDiscoveryFlights.set(rawDiscoveryKey, rawDiscovery);
    void rawDiscovery.then(
      () => {
        if (rawDiscoveryFlights.get(rawDiscoveryKey) === rawDiscovery) {
          rawDiscoveryFlights.delete(rawDiscoveryKey);
        }
      },
      () => {
        if (rawDiscoveryFlights.get(rawDiscoveryKey) === rawDiscovery) {
          rawDiscoveryFlights.delete(rawDiscoveryKey);
        }
      },
    );
  }
  return rawDiscovery;
}

function createSummaryCacheState(
  repository: GitRepository,
  head: string,
  statusOutput: string,
  rawText: string,
  untrackedDigest: string,
  staged: boolean,
  paths: readonly string[],
  responseLimit: number,
): GitDiffSummaryCacheState {
  return {
    repositoryIdentity: repository.root,
    workingDirectory: repository.cwd,
    head,
    dirtyFilesDigest: createHash("sha256")
      .update(statusOutput, "utf8")
      .update("\\0", "utf8")
      .update(rawText, "utf8")
      .update("\\0", "utf8")
      .update(untrackedDigest, "utf8")
      .digest("hex"),
    staged,
    paths,
    maxBytes: responseLimit,
  };
}

async function computeAndCacheSummary(
  exec: GitExec,
  repository: GitRepository,
  signal: AbortSignal | undefined,
  staged: boolean,
  paths: readonly string[],
  responseLimit: number,
  displayStatus: readonly GitStatusEntry[],
  completeStatus: readonly GitStatusEntry[],
  summaryCache: GitDiffSummaryCache,
  cacheState: GitDiffSummaryCacheState,
  claim: GitDiffSummaryCacheClaim,
): Promise<GitDiffSummaryOutput> {
  try {
    const diffResult = await runGit(
      exec,
      diffHunkArgs(staged, paths),
      repository.root,
      signal,
      "read Git diff summary hunks",
    );
    const statResult = await runGit(
      exec,
      diffStatArgs(staged, paths),
      repository.root,
      signal,
      "read Git diff stat",
    );
    const summary = createGitDiffSummary(
      displayStatus,
      statResult.stdout,
      diffResult.stdout,
      responseLimit,
      completeStatus.length > MAX_RECORDS,
      completeStatus,
    );
    summaryCache.set(cacheState, summary);
    return summary;
  } finally {
    summaryCache.releaseClaim(claim);
  }
}

async function executeGitDiffSummary(
  exec: GitExec,
  repository: GitRepository,
  signal: AbortSignal | undefined,
  staged: boolean,
  paths: readonly string[],
  responseLimit: number,
  summaryCache: GitDiffSummaryCache,
  rawDiscoveryFlights: RawDiscoveryFlights,
  previousByRequest: Map<string, GitDiffPreviousSummaryEntry>,
): Promise<GitDiffSummaryOutput | GitDiffSummaryUnchangedOutput> {
  const statusResult = await runGit(
    exec,
    statusArgs(paths),
    repository.root,
    signal,
    "read Git status for diff summary",
  );
  const headResult = await runGit(
    exec,
    ["rev-parse", "HEAD"],
    repository.root,
    signal,
    "read Git repository HEAD for diff summary",
  );
  const completeStatus = selectStatus(parseStatus(statusResult.stdout), staged);
  const displayStatus = completeStatus.slice(0, MAX_RECORDS);
  const { rawText, untrackedDigest } = await discoverRawState(
    exec,
    repository,
    staged,
    paths,
    headResult.stdout.trim(),
    statusResult.stdout,
    completeStatus,
    rawDiscoveryFlights,
  );
  const cacheState = createSummaryCacheState(
    repository,
    headResult.stdout.trim(),
    statusResult.stdout,
    rawText,
    untrackedDigest,
    staged,
    paths,
    responseLimit,
  );
  const requestKey = JSON.stringify([
    repository.root,
    repository.cwd,
    staged,
    paths,
    responseLimit,
  ]);
  const digest = stateKey(cacheState);
  const previous = previousByRequest.get(requestKey);
  if (previous !== undefined && previous.digest === digest) {
    return {
      mode: "summary",
      repositoryRoot: repository.root,
      unchanged: true as const,
      previous,
      output: { truncated: false, totalBytes: 0, totalLines: 0 },
      message:
        'Git diff summary is unchanged since the previous request. Use mode: "patch" with explicit paths for full content.',
    };
  }
  const cached = summaryCache.get(cacheState);
  if (cached !== undefined)
    return attachSummaryIdentity(cached, cacheState, requestKey, previousByRequest);
  const claimResult = await waitForSummaryClaim(summaryCache, cacheState, signal);
  if (claimResult.summary !== undefined) {
    return attachSummaryIdentity(claimResult.summary, cacheState, requestKey, previousByRequest);
  }
  if (claimResult.cancelled) throw gitCancellationError(true);
  const claim = claimResult.claim;
  if (claim === undefined) throw new Error("summary claim was lost before computation");
  const summary = await computeAndCacheSummary(
    exec,
    repository,
    signal,
    staged,
    paths,
    responseLimit,
    displayStatus,
    completeStatus,
    summaryCache,
    cacheState,
    claim,
  );
  return attachSummaryIdentity(summary, cacheState, requestKey, previousByRequest);
}

const MAX_PREVIOUS_SUMMARY_ENTRIES = 256;

function trimPreviousSummaryEntries(entries: Map<string, GitDiffPreviousSummaryEntry>): void {
  while (entries.size > MAX_PREVIOUS_SUMMARY_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) return;
    entries.delete(oldest.value);
  }
}

function attachSummaryIdentity(
  summary: GitDiffSummaryOutput,
  cacheState: GitDiffSummaryCacheState,
  requestKey: string,
  previousByRequest: Map<string, GitDiffPreviousSummaryEntry>,
): GitDiffSummaryOutput {
  previousByRequest.set(requestKey, {
    digest: stateKey(cacheState),
    entryCount: summary.status.length,
    head: cacheState.head,
    dirtyFilesDigest: cacheState.dirtyFilesDigest,
    output: summary.output,
  });
  trimPreviousSummaryEntries(previousByRequest);
  return { ...summary, head: cacheState.head, dirtyFilesDigest: cacheState.dirtyFilesDigest };
}

export function createGitDiffTool(
  exec: GitExec,
  options: GitDiffToolOptions = {},
): GitToolDefinition<typeof gitDiffParameters, GitDiffOutput> {
  const summaryCache = options.summaryCache ?? createGitDiffSummaryCache();
  const rawDiscoveryFlights = new Map<
    string,
    Promise<{ readonly rawText: string; readonly untrackedDigest: string }>
  >();
  const previousByRequest = new Map<string, GitDiffPreviousSummaryEntry>();
  return defineGitTool({
    name: "git_diff",
    label: "Git diff",
    description:
      'Read a bounded Git diff. The default mode is a summary containing status, per-file diff stat, and hunk headers without bodies. Use mode: "patch" with explicit paths: ["file"] for patch content; whole-repository reads use the default summary.',
    promptSnippet: "Inspect a bounded Git diff",
    annotations: { readOnlyHint: true },
    parameters: gitDiffParameters,
    outputSchema: gitDiffOutputSchema,
    renderCall(args, theme) {
      return renderGitDiffCall(args, theme);
    },
    execute: observeGitInvocation<typeof gitDiffParameters, GitDiffOutput>(
      {
        tool: "git_diff",
        schemaHash: hashToolParameters(gitDiffParameters),
        ...options.invocationObservation,
      },
      async (_toolCallId, params, signal, _onUpdate, ctx) => {
        const request = normalizeGitDiffRequest(params);
        const executionSignal = signal ?? ctx.signal;
        const repository = await resolveRepository(exec, ctx.cwd, executionSignal);
        const paths = await resolveGitDiffPaths(repository, params);
        const details =
          request.responseMode === "patch"
            ? await executeGitDiffPatch(
                exec,
                repository,
                executionSignal,
                request.staged,
                paths,
                request.responseLimit,
              )
            : await executeGitDiffSummary(
                exec,
                repository,
                executionSignal,
                request.staged,
                paths,
                request.responseLimit,
                summaryCache,
                rawDiscoveryFlights,
                previousByRequest,
              );
        return makeStructuredToolResult(details);
      },
    ),
  });
}
