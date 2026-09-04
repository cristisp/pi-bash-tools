import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { renderCallLine, renderStringArgument } from "../../call-render.ts";
import { booleanInputSchema } from "../../boolean.ts";
import type { GitDiffOutput, GitDiffSummaryOutput } from "./output.ts";
import {
  createGitDiffSummaryCache,
  type GitDiffSummaryCache,
  type GitDiffSummaryCacheClaim,
  type GitDiffSummaryCacheState,
} from "./cache.ts";
import { createGitDiffSummary } from "./summary.ts";
import type { GitStatusEntry } from "../status/output.ts";
import {
  MAX_CONTENT_BYTES,
  makeToolResult,
  MAX_RECORDS,
  parseStatus,
  truncateUtf8,
  validateIntegerLimit,
} from "../output.ts";
import { resolvePath, resolvePaths, resolveRepository } from "../repository.ts";
import {
  cancellationError,
  invalidGitRequest,
  normalizeGitBoolean,
  runGit,
  validateGitRequestKeys,
  type GitExec,
} from "../execution.ts";
import { defineGitTool, type GitToolDefinition } from "../tool.ts";

export const DEFAULT_GIT_DIFF_MAX_BYTES = 16 * 1024;

export interface GitDiffToolOptions {
  readonly summaryCache?: GitDiffSummaryCache;
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
const gitDiffParameters = Type.Union([
  Type.Object(
    {
      mode,
      staged: stagedSchema,
      maxBytes,
    },
    {
      additionalProperties: false,
      description: "Omit path filters to inspect the whole repository.",
    },
  ),
  Type.Object(
    {
      mode,
      path: Type.String({
        description: 'Legacy single workspace-relative path. For new calls, use paths: ["file"].',
      }),
      staged: stagedSchema,
      maxBytes,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      mode,
      paths: Type.Array(Type.String(), {
        minItems: 1,
        description:
          'New calls should use paths: ["file"] for one path, or list multiple workspace-relative paths.',
      }),
      staged: stagedSchema,
      maxBytes,
    },
    { additionalProperties: false },
  ),
]);

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

function selectStatus(entries: readonly GitStatusEntry[], stagedMode: boolean): GitStatusEntry[] {
  const selected: GitStatusEntry[] = [];
  for (const entry of entries) {
    const selectedStatus = stagedMode ? entry.indexStatus : entry.worktreeStatus;
    const include = stagedMode
      ? selectedStatus !== " " && selectedStatus !== "?"
      : selectedStatus !== " ";
    if (!include) continue;

    const normalized = {
      path: entry.path,
      indexStatus: stagedMode ? selectedStatus : " ",
      worktreeStatus: stagedMode ? " " : selectedStatus,
    };
    if (selectedStatus === "R" || selectedStatus === "C") {
      selected.push(
        entry.renamedFrom === undefined
          ? normalized
          : { ...normalized, renamedFrom: entry.renamedFrom },
      );
    } else {
      selected.push(normalized);
    }
  }
  return selected;
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
  return defineGitTool({
    name: "git_diff",
    label: "Git diff",
    description:
      'Read a bounded Git diff. The default mode is a summary containing status, per-file diff stat, and hunk headers without bodies. Use mode: "patch" explicitly for patch content; for new path-filtered calls, use paths: ["file"].',
    promptSnippet: "Inspect a bounded Git diff",
    parameters: gitDiffParameters,
    renderCall(args, theme) {
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
        args === undefined ? [] : "paths" in args ? args.paths : "path" in args ? [args.path] : [];
      if (paths.length === 0) {
        parts.push(theme.fg("muted", "(whole repository)"));
      } else {
        for (const path of paths) {
          parts.push(renderStringArgument(path, theme));
        }
      }
      parts.push(theme.fg("muted", `maxBytes=${args?.maxBytes ?? DEFAULT_GIT_DIFF_MAX_BYTES}`));
      return renderCallLine(theme, "git_diff", parts);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      validateGitRequestKeys(
        params,
        ["mode", "path", "paths", "staged", "maxBytes"],
        '{ mode?: "summary" | "patch", path?: string, paths?: string[], staged?: boolean, maxBytes?: integer }',
      );
      const hasLegacyPath = "path" in params;
      const hasPaths = "paths" in params;
      if (hasLegacyPath && hasPaths) {
        throw invalidGitRequest("provide either path or paths, not both", "path");
      }
      const responseMode = params.mode ?? "summary";
      if (responseMode !== "summary" && responseMode !== "patch") {
        throw invalidGitRequest('mode must be either "summary" or "patch"', "mode");
      }
      const staged = normalizeGitBoolean(params.staged, "staged") === true;
      const responseLimit = params.maxBytes ?? DEFAULT_GIT_DIFF_MAX_BYTES;
      validateIntegerLimit(responseLimit, 1, MAX_CONTENT_BYTES, "maxBytes");
      const repository = await resolveRepository(exec, ctx.cwd, signal ?? ctx.signal);
      const paths = hasPaths
        ? await resolvePaths(repository, params.paths)
        : hasLegacyPath
          ? [await resolvePath(repository, params.path)]
          : [];
      const diffPaths = paths;
      if (responseMode === "patch") {
        const result = await runGit(
          exec,
          diffArgs(staged, diffPaths),
          repository.root,
          signal ?? ctx.signal,
          "read Git diff",
        );
        const bounded = truncateUtf8(result.stdout, responseLimit);
        const message = bounded.output.truncated
          ? `INCOMPLETE git_diff patch: ${bounded.output.totalBytes} bytes were available and only the first ${responseLimit} bytes are returned. Follow up with an explicit scoped request using mode: "patch", paths: ["file"], and a larger maxBytes.`
          : undefined;
        return makeToolResult({
          mode: "patch" as const,
          patch: bounded.text,
          output: bounded.output,
          ...(message === undefined ? {} : { message }),
        });
      }

      const statusResult = await runGit(
        exec,
        statusArgs(paths),
        repository.root,
        signal ?? ctx.signal,
        "read Git status for diff summary",
      );
      const headResult = await runGit(
        exec,
        ["rev-parse", "HEAD"],
        repository.root,
        signal ?? ctx.signal,
        "read Git repository HEAD for diff summary",
      );
      const completeStatus = selectStatus(parseStatus(statusResult.stdout), staged);
      const displayStatus = completeStatus.slice(0, MAX_RECORDS);
      const rawDiscoveryKey = createHash("sha256")
        .update(
          JSON.stringify({
            repositoryRoot: repository.root,
            workingDirectory: repository.cwd,
            head: headResult.stdout.trim(),
            status: statusResult.stdout,
            staged,
            paths: diffPaths,
          }),
          "utf8",
        )
        .digest("hex");
      let rawDiscovery = rawDiscoveryFlights.get(rawDiscoveryKey);
      if (rawDiscovery === undefined) {
        rawDiscovery = Promise.all([
          runGit(
            exec,
            diffRawArgs(staged, diffPaths),
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
      const { rawText, untrackedDigest } = await rawDiscovery;
      const cacheState: GitDiffSummaryCacheState = {
        repositoryIdentity: repository.root,
        workingDirectory: repository.cwd,
        head: headResult.stdout.trim(),
        dirtyFilesDigest: createHash("sha256")
          .update(statusResult.stdout, "utf8")
          .update("\\0", "utf8")
          .update(rawText, "utf8")
          .update("\\0", "utf8")
          .update(untrackedDigest, "utf8")
          .digest("hex"),
        staged,
        paths: diffPaths,
        maxBytes: responseLimit,
      };
      const cached = summaryCache.get(cacheState);
      if (cached !== undefined) return makeToolResult(cached);
      const claimResult = await waitForSummaryClaim(summaryCache, cacheState, signal ?? ctx.signal);
      if (claimResult.summary !== undefined) return makeToolResult(claimResult.summary);
      if (claimResult.cancelled) throw cancellationError(true);
      const claim = claimResult.claim;
      if (claim === undefined) throw new Error("summary claim was lost before computation");
      try {
        const diffResult = await runGit(
          exec,
          diffHunkArgs(staged, diffPaths),
          repository.root,
          signal ?? ctx.signal,
          "read Git diff summary hunks",
        );
        const statResult = await runGit(
          exec,
          diffStatArgs(staged, diffPaths),
          repository.root,
          signal ?? ctx.signal,
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
        return makeToolResult(summary);
      } finally {
        summaryCache.releaseClaim(claim);
      }
    },
  });
}
