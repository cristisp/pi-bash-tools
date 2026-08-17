import { Type } from "typebox";
import {
  countStatusRecords,
  MAX_RECORDS,
  makeToolResult,
  parseStatus,
  STRUCTURED_OUTPUT_LIMIT,
  truncateUtf8,
} from "../output.ts";
import type { GitStatusOutput } from "./output.ts";
import { resolvePath, resolveRepository } from "../repository.ts";
import { runGit, type GitExec } from "../execution.ts";
import { defineGitTool, type GitToolDefinition } from "../tool.ts";

const gitStatusParameters = Type.Object({
  path: Type.Optional(Type.String({ description: "Optional workspace-relative path" })),
});

export function createGitStatusTool(
  exec: GitExec,
): GitToolDefinition<typeof gitStatusParameters, GitStatusOutput> {
  return defineGitTool({
    name: "git_status",
    label: "Git status",
    description: "Read Git working tree status for the current workspace without changing files.",
    promptSnippet: "Inspect Git working tree status",
    parameters: gitStatusParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
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
      return makeToolResult({ repositoryRoot: repository.root, entries, output });
    },
  });
}
