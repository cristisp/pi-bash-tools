import { Type } from "typebox";
import { renderCallLine, renderStringArgument } from "../../call-render.ts";
import { booleanInputSchema } from "../../boolean.ts";
import type { GitDiffOutput } from "./output.ts";
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
  invalidGitRequest,
  normalizeGitBoolean,
  runGit,
  validateGitRequestKeys,
  type GitExec,
} from "../execution.ts";
import { defineGitTool, type GitToolDefinition } from "../tool.ts";

export const DEFAULT_GIT_DIFF_MAX_BYTES = 16 * 1024;

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

function diffHunkArgs(stagedMode: boolean, paths: readonly string[]): string[] {
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--unified=0"];
  if (stagedMode) args.push("--cached");
  args.push("--", ...paths);
  return args;
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
): GitToolDefinition<typeof gitDiffParameters, GitDiffOutput> {
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
      const completeStatus = selectStatus(parseStatus(statusResult.stdout), staged);
      const displayStatus = completeStatus.slice(0, MAX_RECORDS);
      const statResult = await runGit(
        exec,
        diffStatArgs(staged, diffPaths),
        repository.root,
        signal ?? ctx.signal,
        "read Git diff stat",
      );
      const diffResult = await runGit(
        exec,
        diffHunkArgs(staged, diffPaths),
        repository.root,
        signal ?? ctx.signal,
        "read Git diff summary hunks",
      );
      return makeToolResult(
        createGitDiffSummary(
          displayStatus,
          statResult.stdout,
          diffResult.stdout,
          responseLimit,
          completeStatus.length > MAX_RECORDS,
          completeStatus,
        ),
      );
    },
  });
}
