import { Type } from "typebox";
import type { GitDiffOutput } from "./output.ts";
import {
  MAX_CONTENT_BYTES,
  makeToolResult,
  truncateUtf8,
  validateIntegerLimit,
} from "../output.ts";
import { resolvePath, resolvePaths, resolveRepository } from "../repository.ts";
import { runGit, type GitExec } from "../execution.ts";
import { defineGitTool, type GitToolDefinition } from "../tool.ts";

const gitDiffParameters = Type.Object({
  path: Type.Optional(Type.String({ description: "One workspace-relative path" })),
  staged: Type.Optional(Type.Boolean({ description: "Read the staged index diff" })),
  paths: Type.Optional(
    Type.Array(Type.String(), { description: "Several workspace-relative paths" }),
  ),
  maxBytes: Type.Integer({
    minimum: 1,
    maximum: MAX_CONTENT_BYTES,
    description: "Maximum patch bytes",
  }),
});

export function createGitDiffTool(
  exec: GitExec,
): GitToolDefinition<typeof gitDiffParameters, GitDiffOutput> {
  return defineGitTool({
    name: "git_diff",
    label: "Git diff",
    description:
      "Read a bounded Git diff for workspace-relative paths without changing the repository.",
    promptSnippet: "Inspect a bounded Git diff",
    parameters: gitDiffParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      validateIntegerLimit(params.maxBytes, 1, MAX_CONTENT_BYTES, "maxBytes");
      if (params.path !== undefined && params.paths !== undefined) {
        throw new Error("provide either path or paths, not both");
      }
      const repository = await resolveRepository(exec, ctx.cwd, signal ?? ctx.signal);
      const paths =
        params.paths !== undefined
          ? await resolvePaths(repository, params.paths)
          : params.path !== undefined
            ? [await resolvePath(repository, params.path)]
            : [];
      const args = ["diff", "--no-ext-diff", "--no-textconv", "--binary"];
      if (params.staged === true) {
        args.push("--cached");
      }
      args.push("--", ...paths);
      const result = await runGit(
        exec,
        args,
        repository.root,
        signal ?? ctx.signal,
        "read Git diff",
      );
      const bounded = truncateUtf8(result.stdout, params.maxBytes);
      return makeToolResult({ patch: bounded.text, output: bounded.output });
    },
  });
}
