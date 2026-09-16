import { Type } from "typebox";

import { hashToolParameters } from "../../../observability/canonical-json.ts";
import { renderCallLine, renderStringArgument } from "../../call-render.ts";
import { runGit, validateRevision, type GitExec } from "../execution.ts";
import { observeGitInvocation, type GitInvocationObservationOptions } from "../invocation.ts";
import {
  MAX_CONTENT_BYTES,
  makeToolResult,
  truncateUtf8,
  validateIntegerLimit,
} from "../output.ts";
import { resolvePath, resolveRepository } from "../repository.ts";
import { defineGitTool, type GitToolDefinition } from "../tool.ts";
import type { GitShowOutput } from "./output.ts";

const gitShowParameters = Type.Object(
  {
    revision: Type.String({
      description:
        "Safe Git revision or revision range to inspect; do not include a REV:path expression because path is a separate field. Empty compatibility values are treated as absent and then rejected.",
    }),
    path: Type.Optional(
      Type.String({
        description:
          "Optional workspace-relative path filter within the revision; omit or pass an empty compatibility value to inspect the revision's complete bounded output.",
      }),
    ),
    maxBytes: Type.Integer({
      minimum: 1,
      maximum: MAX_CONTENT_BYTES,
      description: `Maximum UTF-8 response bytes; output beyond this limit is truncated (maximum ${MAX_CONTENT_BYTES}).`,
    }),
  },
  {
    additionalProperties: false,
    description:
      "Read bounded output from a safe Git revision, optionally filtered to a workspace-relative path. This tool does not mutate the repository.",
  },
);

export function createGitShowTool(
  exec: GitExec,
  observation?: GitInvocationObservationOptions,
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
    execute: observeGitInvocation<typeof gitShowParameters, GitShowOutput>(
      { tool: "git_show", schemaHash: hashToolParameters(gitShowParameters), ...observation },
      async (_toolCallId, params, signal, _onUpdate, ctx) => {
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
    ),
  });
}
