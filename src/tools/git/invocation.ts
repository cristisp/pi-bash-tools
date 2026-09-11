import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

import { sharedRepositoryId, sharedWorkspaceBlock } from "../../evidence/envelope.ts";
import {
  recordGitInvocation,
  type GitInvocationReason,
  type GitInvocationRecorder,
  type GitInvocationToolName,
} from "../../observability/git-invocation.ts";
import type { ProjectCommandRepositoryStateReader } from "../project-command/repository-state.ts";
import { GitToolError } from "./execution.ts";
import type { GitToolContext, GitToolExecute } from "./tool.ts";

export interface GitInvocationObservationOptions {
  readonly invocationRecorder?: GitInvocationRecorder | undefined;
  readonly repositoryStateReader?: ProjectCommandRepositoryStateReader | undefined;
}

type GitInvocationRepositoryState =
  | ReturnType<typeof sharedWorkspaceBlock>
  | {
      readonly repositoryId: string;
      readonly head: null;
      readonly dirtyDigest: null;
      readonly status: "degraded";
    };

function classifyGitError(error: unknown): {
  readonly reason: GitInvocationReason;
  readonly errorCode?: string;
} {
  if (error instanceof GitToolError) {
    const code = error.contract.code;
    if (code === "invalid-request") return { reason: "invalid-request", errorCode: code };
    if (code === "cancelled") return { reason: "cancelled", errorCode: code };
    return { reason: "failed", errorCode: code };
  }
  return { reason: "failed" };
}

function requestedPathCount(params: unknown): number {
  if (typeof params !== "object" || params === null) return 0;
  const record = params as { readonly path?: unknown; readonly paths?: unknown };
  if (typeof record.path === "string") return 1;
  return Array.isArray(record.paths) ? record.paths.length : 0;
}

function unchangedFlag(details: unknown): boolean {
  return (
    typeof details === "object" &&
    details !== null &&
    (details as { unchanged?: unknown }).unchanged === true
  );
}

function degradedWorkspaceBlock(details: unknown): GitInvocationRepositoryState | undefined {
  const root =
    typeof details === "object" && details !== null
      ? (details as { repositoryRoot?: unknown }).repositoryRoot
      : undefined;
  if (typeof root !== "string" || root.length === 0) return undefined;
  return Object.freeze({
    repositoryId: sharedRepositoryId(root),
    head: null,
    dirtyDigest: null,
    status: "degraded",
  });
}

function gitSessionId(ctx: GitToolContext): string | undefined {
  const value = ctx.sessionManager?.getSessionId();
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Record a bounded invocation for one Git read call, including the shared repository-state
 * workspace block. Observation runs concurrently with the tool's own Git work, is gated on
 * recorder and session identity, and never changes a result or an error.
 */
export function observeGitInvocation<P extends TSchema, D extends object>(
  options: {
    readonly tool: GitInvocationToolName;
    readonly schemaHash: string;
    readonly invocationRecorder?: GitInvocationRecorder | undefined;
    readonly repositoryStateReader?: ProjectCommandRepositoryStateReader | undefined;
  },
  execute: GitToolExecute<P, D>,
): GitToolExecute<P, D> {
  const { invocationRecorder, repositoryStateReader, schemaHash, tool } = options;
  return async (toolCallId, params, signal, onUpdate, ctx) => {
    const startedAt = performance.now();
    const sessionId = gitSessionId(ctx);
    const observeState = invocationRecorder !== undefined && sessionId !== undefined;
    const observedStatePromise =
      observeState && repositoryStateReader !== undefined
        ? repositoryStateReader(ctx.cwd, signal ?? ctx.signal).catch(() => undefined)
        : undefined;
    const record = (
      reason: GitInvocationReason,
      details: D | undefined,
      errorCode: string | undefined,
      repositoryState: GitInvocationRepositoryState | undefined,
    ): void => {
      if (sessionId === undefined) return;
      let resultBytes = 0;
      if (details !== undefined) {
        try {
          resultBytes = Buffer.byteLength(JSON.stringify(details), "utf8");
        } catch {
          resultBytes = 0;
        }
      }
      recordGitInvocation(invocationRecorder, {
        tool,
        sessionId,
        toolCallId,
        schemaHash,
        requestedPaths: requestedPathCount(params),
        reason,
        durationMs: performance.now() - startedAt,
        unchanged: unchangedFlag(details),
        resultBytes,
        ...(errorCode === undefined ? {} : { errorCode }),
        ...(repositoryState === undefined ? {} : { repositoryState }),
      });
    };
    try {
      const outcome = await execute(toolCallId, params, signal, onUpdate, ctx);
      let repositoryState: GitInvocationRepositoryState | undefined;
      if (observedStatePromise !== undefined) {
        const observed = await observedStatePromise;
        if (observed === undefined) {
          repositoryState = degradedWorkspaceBlock(outcome.details);
        } else {
          try {
            repositoryState = sharedWorkspaceBlock(observed);
          } catch {
            repositoryState = undefined;
          }
        }
      }
      record("completed", outcome.details, undefined, repositoryState);
      return outcome;
    } catch (error) {
      const classified = classifyGitError(error);
      record(classified.reason, undefined, classified.errorCode, undefined);
      throw error;
    }
  };
}

export interface GitInvocationSessionContext extends GitToolContext {
  readonly sessionManager?: Pick<ExtensionContext["sessionManager"], "getSessionId">;
}
