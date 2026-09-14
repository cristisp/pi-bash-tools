import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";

import { sharedRepositoryId, sharedWorkspaceBlock } from "../../evidence/envelope.ts";
import {
  recordGitInvocation,
  type GitInvocationReason,
  type GitInvocationRecorder,
  type GitInvocationRetryInvalidation,
  type GitInvocationToolName,
} from "../../observability/git-invocation.ts";
import type { ProjectCommandRepositoryStateReader } from "../project-command/repository-state.ts";
import { GitToolError, unchangedInvalidGitRequest } from "./execution.ts";
import {
  invalidRequestFingerprint,
  type InvalidGitRequestKey,
  type InvalidGitRequestTracker,
} from "./invalid-request-tracker.ts";
import type { GitToolContext, GitToolExecute } from "./tool.ts";

export interface GitInvocationObservationOptions {
  readonly invocationRecorder?: GitInvocationRecorder | undefined;
  readonly repositoryStateReader?: ProjectCommandRepositoryStateReader | undefined;
  readonly retryInvalidationTracker?: InvalidGitRequestTracker | undefined;
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
    if (code === "invalid-request" || code === "unchanged-invalid-request") {
      return { reason: "invalid-request", errorCode: code };
    }
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

function truncatedFlag(details: unknown): boolean | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const output = (details as { output?: unknown }).output;
  if (typeof output !== "object" || output === null) return undefined;
  const truncated = (output as { truncated?: unknown }).truncated;
  return typeof truncated === "boolean" ? truncated : undefined;
}

/**
 * Record the tool-specific request fields the generic wrapper cannot infer. `mode` is the
 * effective diff mode and `maxBytes` is the requested response limit when the tool accepts one;
 * other tools record neither. Recording is additive and never changes the executed request.
 */
function recordableGitParameters(
  tool: GitInvocationToolName,
  params: unknown,
  details: unknown,
): { readonly mode?: "summary" | "patch"; readonly maxBytes?: number } {
  if (typeof params !== "object" || params === null) return {};
  const record = params as { readonly mode?: unknown; readonly maxBytes?: unknown };
  const maxBytes =
    typeof record.maxBytes === "number" && Number.isFinite(record.maxBytes) && record.maxBytes >= 0
      ? record.maxBytes
      : undefined;
  if (tool === "git_diff") {
    const reportedMode =
      typeof details === "object" && details !== null
        ? (details as { mode?: unknown }).mode
        : undefined;
    return {
      mode:
        reportedMode === "patch" || reportedMode === "summary"
          ? reportedMode
          : record.mode === "patch"
            ? "patch"
            : "summary",
      ...(maxBytes === undefined ? {} : { maxBytes }),
    };
  }
  if (tool === "git_show") {
    return maxBytes === undefined ? {} : { maxBytes };
  }
  return {};
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
 * The only coercion this wrapper performs: an empty optional field is treated as absent. Entry
 * values inside `paths` are never dropped, because that would silently widen the request scope.
 */
const EMPTY_OPTIONAL_FIELDS: readonly (readonly [string, string])[] = [
  ["path", "path:empty-string-omitted"],
  ["revision", "revision:empty-string-omitted"],
];

function coerceEmptyOptionalFields<P extends TSchema>(
  params: Static<P>,
): {
  readonly params: Static<P>;
  readonly fingerprintParams: Static<P>;
  readonly coercions: readonly string[];
} {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return { params, fingerprintParams: params, coercions: [] };
  }
  const omitted = EMPTY_OPTIONAL_FIELDS.filter(
    ([field]) => Object.hasOwn(params, field) && Reflect.get(params, field) === "",
  );
  if (omitted.length === 0) return { params, fingerprintParams: params, coercions: [] };
  const copy = { ...params };
  const fingerprintParams = { ...params };
  for (const [field] of omitted) {
    Reflect.set(copy, field, undefined);
    Reflect.deleteProperty(fingerprintParams, field);
  }
  return {
    params: copy,
    fingerprintParams,
    coercions: omitted.map(([, name]) => name),
  };
}

function unchangedInvalidRequestKey(
  sessionId: string,
  tool: GitInvocationToolName,
  params: unknown,
): InvalidGitRequestKey | undefined {
  const fingerprint = invalidRequestFingerprint(params);
  if (fingerprint === undefined) return undefined;
  return { sessionId, tool, fingerprint };
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
    readonly retryInvalidationTracker?: InvalidGitRequestTracker | undefined;
  },
  execute: GitToolExecute<P, D>,
): GitToolExecute<P, D> {
  const { invocationRecorder, repositoryStateReader, retryInvalidationTracker, schemaHash, tool } =
    options;
  return async (toolCallId, requestParams, signal, onUpdate, ctx) => {
    const startedAt = performance.now();
    const sessionId = gitSessionId(ctx);
    const { params, fingerprintParams, coercions } = coerceEmptyOptionalFields(requestParams);
    const invalidRequestKey =
      retryInvalidationTracker === undefined || sessionId === undefined
        ? undefined
        : unchangedInvalidRequestKey(sessionId, tool, fingerprintParams);
    const observeState = invocationRecorder !== undefined && sessionId !== undefined;
    const record = (
      reason: GitInvocationReason,
      details: D | undefined,
      errorCode: string | undefined,
      repositoryState: GitInvocationRepositoryState | undefined,
      retryInvalidation?: GitInvocationRetryInvalidation,
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
      const truncated = reason === "completed" ? truncatedFlag(details) : undefined;
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
        ...(coercions.length === 0 ? {} : { coercions }),
        ...(retryInvalidation === undefined ? {} : { retryInvalidation }),
        ...(repositoryState === undefined ? {} : { repositoryState }),
        ...(reason === "completed" ? recordableGitParameters(tool, params, details) : {}),
        ...(truncated === undefined ? {} : { truncated }),
      });
    };
    if (
      invalidRequestKey !== undefined &&
      retryInvalidationTracker !== undefined &&
      retryInvalidationTracker.findUnchangedInvalidRequest(invalidRequestKey)
    ) {
      record(
        "invalid-request",
        undefined,
        "unchanged-invalid-request",
        undefined,
        "invalid-request-repeat",
      );
      throw unchangedInvalidGitRequest();
    }
    const observedStatePromise =
      observeState && repositoryStateReader !== undefined
        ? repositoryStateReader(ctx.cwd, signal ?? ctx.signal).catch(() => undefined)
        : undefined;
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
      if (
        invalidRequestKey !== undefined &&
        retryInvalidationTracker !== undefined &&
        error instanceof GitToolError &&
        error.contract.shapeDeterministic === true
      ) {
        retryInvalidationTracker.rememberUnchangedInvalidRequest(invalidRequestKey);
      }
      record(classified.reason, undefined, classified.errorCode, undefined);
      throw error;
    }
  };
}

export interface GitInvocationSessionContext extends GitToolContext {
  readonly sessionManager?: Pick<ExtensionContext["sessionManager"], "getSessionId">;
}
