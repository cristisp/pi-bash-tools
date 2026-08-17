import { Type } from "typebox";
import type { GitLogOutput } from "./output.ts";
import {
  MAX_RECORDS,
  makeToolResult,
  parseLog,
  STRUCTURED_OUTPUT_LIMIT,
  truncateUtf8,
  validateIntegerLimit,
} from "../output.ts";
import { resolvePath, resolveRepository } from "../repository.ts";
import { runGit, validateRevision, type GitExec } from "../execution.ts";
import { defineGitTool, type GitToolDefinition } from "../tool.ts";

const gitLogParameters = Type.Object({
  path: Type.Optional(Type.String({ description: "Optional workspace-relative path" })),
  revision: Type.Optional(Type.String({ description: "Optional Git revision or revision range" })),
  maxEntries: Type.Integer({ minimum: 1, maximum: MAX_RECORDS, description: "Maximum commits" }),
});

export function createGitLogTool(
  exec: GitExec,
): GitToolDefinition<typeof gitLogParameters, GitLogOutput> {
  return defineGitTool({
    name: "git_log",
    label: "Git log",
    description:
      "Read bounded Git commit history with safe revision and workspace-relative path filters.",
    promptSnippet: "Inspect bounded Git history",
    parameters: gitLogParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      validateIntegerLimit(params.maxEntries, 1, MAX_RECORDS, "maxEntries");
      const revision =
        params.revision === undefined ? undefined : validateRevision(params.revision);
      const repository = await resolveRepository(exec, ctx.cwd, signal ?? ctx.signal);
      const path =
        params.path === undefined ? undefined : await resolvePath(repository, params.path);
      const args = [
        "log",
        "--no-ext-diff",
        "--no-textconv",
        "--no-decorate",
        "--date=iso-strict",
        "--format=format:%H%x00%an%x00%aI%x00%s%x00",
        `--max-count=${params.maxEntries}`,
      ];
      if (revision !== undefined) {
        args.push(revision);
      }
      args.push("--");
      if (path !== undefined) {
        args.push(path);
      }
      const result = await runGit(
        exec,
        args,
        repository.root,
        signal ?? ctx.signal,
        "read Git log",
      );
      const bounded = truncateUtf8(result.stdout, STRUCTURED_OUTPUT_LIMIT);
      const fields = bounded.text.split("\0");
      const completeFieldCount = Math.floor((fields.length - 1) / 4) * 4;
      const completeOutput =
        completeFieldCount === 0 ? "" : `${fields.slice(0, completeFieldCount).join("\0")}\0`;
      const entries = parseLog(completeOutput).slice(0, params.maxEntries);
      const totalEntries = parseLog(result.stdout).length;
      return makeToolResult({
        entries,
        output: {
          ...bounded.output,
          truncated: bounded.output.truncated || totalEntries > params.maxEntries,
          totalLines: totalEntries,
        },
      });
    },
  });
}
