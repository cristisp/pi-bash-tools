import { createHash } from "node:crypto";

import { Type } from "typebox";

import { hashToolParameters } from "../../../observability/canonical-json.ts";
import { booleanInputSchema } from "../../boolean.ts";
import { renderCallLine, renderStringArgument } from "../../call-render.ts";
import { contentDigest } from "../../project-command/repository-state/dirty-files.ts";
import { normalizeGitBoolean, runGit, validateGitRequestKeys, type GitExec } from "../execution.ts";
import { observeGitInvocation, type GitInvocationObservationOptions } from "../invocation.ts";
import {
  countStatusRecords,
  MAX_RECORDS,
  makeToolResult,
  parseStatus,
  STRUCTURED_OUTPUT_LIMIT,
  truncateUtf8,
} from "../output.ts";
import { resolvePath, resolveRepository } from "../repository.ts";
import { defineGitTool, type GitToolDefinition } from "../tool.ts";
import type { GitStatusChangedOutput, GitStatusOutput } from "./output.ts";

const MAX_PREVIOUS_STATUS_ENTRIES = 256;

function trimPreviousStatusEntries<T>(entries: Map<string, T>): void {
  while (entries.size > MAX_PREVIOUS_STATUS_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) return;
    entries.delete(oldest.value);
  }
}

const gitStatusParameters = Type.Object(
  {
    path: Type.Optional(Type.String({ description: "Optional workspace-relative path" })),
    refresh: Type.Optional(booleanInputSchema),
  },
  {
    additionalProperties: false,
    description:
      "Optionally request a fresh rendering even when the status is unchanged. The default is false.",
  },
);

export function createGitStatusTool(
  exec: GitExec,
  observation?: GitInvocationObservationOptions,
): GitToolDefinition<typeof gitStatusParameters, GitStatusOutput> {
  const previousByRequest = new Map<
    string,
    {
      readonly digest: string;
      readonly entryCount: number;
      readonly output: GitStatusChangedOutput["output"];
    }
  >();

  return defineGitTool({
    name: "git_status",
    label: "Git status",
    description: "Read Git working tree status for the current workspace without changing files.",
    promptSnippet: "Inspect Git working tree status",
    parameters: gitStatusParameters,
    renderCall(args, theme) {
      const parts = args?.path === undefined ? [] : [renderStringArgument(args.path, theme)];
      if (args?.refresh === true || args?.refresh === "true") {
        parts.push(theme.fg("muted", "refresh"));
      }
      return renderCallLine(theme, "git_status", parts);
    },
    execute: observeGitInvocation<typeof gitStatusParameters, GitStatusOutput>(
      { tool: "git_status", schemaHash: hashToolParameters(gitStatusParameters), ...observation },
      async (_toolCallId, params, signal, _onUpdate, ctx) => {
        validateGitRequestKeys(
          params,
          ["path", "refresh"],
          '{ path?: string, refresh?: boolean | "true" | "false" }',
        );
        const refresh = normalizeGitBoolean(params.refresh, "refresh") === true;
        const repository = await resolveRepository(exec, ctx.cwd, signal ?? ctx.signal);
        const path =
          params.path === undefined ? undefined : await resolvePath(repository, params.path);
        const args = ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--"];
        if (path !== undefined) {
          args.push(path);
        }
        const result = await runGit(
          exec,
          args,
          repository.root,
          signal ?? ctx.signal,
          "read Git status",
        );
        const recordCount = countStatusRecords(result.stdout);
        const bounded = truncateUtf8(result.stdout, STRUCTURED_OUTPUT_LIMIT, recordCount);
        const completeOutput = bounded.text.slice(0, bounded.text.lastIndexOf("\0") + 1);
        const entries = parseStatus(completeOutput).slice(0, MAX_RECORDS);
        const output = {
          ...bounded.output,
          truncated: bounded.output.truncated || recordCount > MAX_RECORDS,
        };
        const key = JSON.stringify([repository.root, path ?? null]);
        const digest = createHash("sha256").update(result.stdout, "utf8").digest("hex");
        const previous = previousByRequest.get(key);
        if (previous !== undefined && previous.digest === digest && !refresh) {
          return makeToolResult({
            repositoryRoot: repository.root,
            unchanged: true as const,
            previous,
            output: { truncated: false, totalBytes: 0, totalLines: 0 },
            message:
              "Git status is unchanged since the previous request. Use { refresh: true } to force a fresh rendering.",
          });
        }
        const executionSignal = signal ?? ctx.signal;
        const [head, dirtyFilesDigest] = await Promise.all([
          runGit(
            exec,
            ["rev-parse", "HEAD"],
            repository.root,
            executionSignal,
            "read Git repository HEAD for status identity",
          )
            .then((headResult) => headResult.stdout.trim())
            .catch(() => undefined),
          contentDigest(
            repository.root,
            result.stdout,
            exec,
            repository.root,
            executionSignal,
          ).catch(() => undefined),
        ]);
        const current = {
          digest,
          entryCount: recordCount,
          output,
          ...(head === undefined ? {} : { head }),
          ...(dirtyFilesDigest === undefined ? {} : { dirtyFilesDigest }),
        };
        previousByRequest.set(key, current);
        trimPreviousStatusEntries(previousByRequest);
        return makeToolResult({
          repositoryRoot: repository.root,
          unchanged: false as const,
          entries,
          ...(head === undefined ? {} : { head }),
          ...(dirtyFilesDigest === undefined ? {} : { dirtyFilesDigest }),
          output,
        });
      },
    ),
  });
}
