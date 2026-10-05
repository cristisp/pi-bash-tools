import {
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";

import type { BashToolAnnotations } from "../annotations.ts";

export type GitToolContext = Pick<ExtensionContext, "cwd" | "signal"> & {
  readonly sessionManager?: Pick<ExtensionContext["sessionManager"], "getSessionId">;
};

export type GitToolExecute<P extends TSchema, D> = (
  toolCallId: string,
  params: Static<P>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<D> | undefined,
  ctx: GitToolContext,
) => Promise<AgentToolResult<D>>;

export type GitToolDefinition<P extends TSchema, D> = Omit<ToolDefinition<P, D>, "execute"> & {
  annotations?: BashToolAnnotations;
  execute: GitToolExecute<P, D>;
};

export function defineGitTool<P extends TSchema, D>(
  tool: Omit<ToolDefinition<P, D>, "execute"> & {
    annotations?: BashToolAnnotations;
    execute: GitToolExecute<P, D>;
  },
): GitToolDefinition<P, D> {
  return tool;
}
