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

const staged = Type.Optional(Type.Boolean({ description: "Read the staged index diff" }));
const maxBytes = Type.Integer({
  minimum: 1,
  maximum: MAX_CONTENT_BYTES,
  description: "Maximum patch bytes",
});
const gitDiffParameters = Type.Union([
  Type.Object(
    {
      staged,
      maxBytes,
    },
    {
      additionalProperties: false,
      description: "Omit path filters to diff the whole repository.",
    },
  ),
  Type.Object(
    {
      path: Type.String({
        description: 'Legacy single workspace-relative path. For new calls, use paths: ["file"].',
      }),
      staged,
      maxBytes,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      paths: Type.Array(Type.String(), {
        description:
          'New calls should use paths: ["file"] for one path, or list multiple workspace-relative paths.',
      }),
      staged,
      maxBytes,
    },
    { additionalProperties: false },
  ),
]);

export function createGitDiffTool(
  exec: GitExec,
): GitToolDefinition<typeof gitDiffParameters, GitDiffOutput> {
  return defineGitTool({
    name: "git_diff",
    label: "Git diff",
    description:
      'Read a bounded Git diff for the whole repository or workspace-relative paths without changing the repository. For new path-filtered calls, use paths: ["file"]; the legacy path field remains supported.',
    promptSnippet: "Inspect a bounded Git diff",
    parameters: gitDiffParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const hasLegacyPath = "path" in params;
      const hasPaths = "paths" in params;
      if (hasLegacyPath && hasPaths) {
        throw new Error("provide either path or paths, not both");
      }
      validateIntegerLimit(params.maxBytes, 1, MAX_CONTENT_BYTES, "maxBytes");
      const repository = await resolveRepository(exec, ctx.cwd, signal ?? ctx.signal);
      const paths = hasPaths
        ? await resolvePaths(repository, params.paths)
        : hasLegacyPath
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
