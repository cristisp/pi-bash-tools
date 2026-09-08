import { Type } from "typebox";

import { renderCallLine, renderStringArgument } from "../../call-render.ts";
import { runGit, validateRevision, type GitExec } from "../execution.ts";
import {
  MAX_CONTENT_BYTES,
  makeToolResult,
  truncateUtf8,
  validateIntegerLimit,
} from "../output.ts";
import { resolvePath, resolveRepository } from "../repository.ts";
import { defineGitTool, type GitToolDefinition } from "../tool.ts";
import type { GitShowOutput } from "./output.ts";

const gitShowParameters = Type.Object({
  revision: Type.String({ description: "Git revision, not a REV:path expression" }),
  path: Type.Optional(Type.String({ description: "Optional workspace-relative path filter" })),
  maxBytes: Type.Integer({
    minimum: 1,
    maximum: MAX_CONTENT_BYTES,
    description: "Maximum output bytes",
  }),
});

export function createGitShowTool(
  exec: GitExec,
): GitToolDefinition<typeof gitShowParameters, GitShowOutput> {
  return defineGitTool({
    name: "git_show",
    label: "Git show",
    description:
      "Read bounded output from a Git revision, optionally filtered to a workspace-relative path.",
    promptSnippet: "Inspect a bounded Git revision",
    parameters: gitShowParameters,
    renderCall(args, theme) {
      const parts = [
        renderStringArgument(args?.revision, theme),
        ...(args?.path === undefined ? [] : [renderStringArgument(args.path, theme)]),
        theme.fg("muted", `maxBytes=${args?.maxBytes ?? "?"}`),
      ];
      return renderCallLine(theme, "git_show", parts);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      validateIntegerLimit(params.maxBytes, 1, MAX_CONTENT_BYTES, "maxBytes");
      const revision = validateRevision(params.revision);
      const repository = await resolveRepository(exec, ctx.cwd, signal ?? ctx.signal);
      const path =
        params.path === undefined ? undefined : await resolvePath(repository, params.path);
      const args = ["show", "--no-ext-diff", "--no-textconv", revision, "--"];
      if (path !== undefined) {
        args.push(path);
      }
      const result = await runGit(
        exec,
        args,
        repository.root,
        signal ?? ctx.signal,
        "read Git show",
      );
      const bounded = truncateUtf8(result.stdout, params.maxBytes);
      return makeToolResult({ content: bounded.text, output: bounded.output });
    },
  });
}
