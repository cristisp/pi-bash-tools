import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";

import {
  isToolCallEventType,
  type ToolCallEvent,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import type {
  AuthorizationOutcomeObserver,
  AuthorizationOutcomeRecorder,
} from "../../observability/authorization-outcome.ts";
import { createAuthorizationOutcomeObserver } from "../../observability/authorization-outcome.ts";
import type { AuthorizationRetryTracker } from "../authorization-retry.ts";
import { authorizationRequestFingerprint } from "../authorization-retry.ts";
import { type AuthorizationErrorKind } from "../authorization.ts";
import type { ToolErrorContract } from "../errors.ts";
import { displayPath } from "../path-display.ts";
import { filesystemPolicyDenialMetadata } from "../policy/decisions.ts";
import { createPolicyStore } from "../policy/store.ts";
import type {
  FilesystemAccess,
  LoadedPolicy,
  PolicyAuthorization,
  PolicyStore,
} from "../policy/types.ts";
import {
  effectiveOrchestrationFlowId,
  readProjectCommandOrchestrationContext,
} from "../project-command/orchestration.ts";
import {
  authorizeAndPersistFilesystemAccesses,
  loadFilesystemPolicyForRequest,
  type FilesystemAuthorizationContext,
} from "./authorization.ts";
import { diagnoseFilesystemEdits, type FilesystemEditInput } from "./edit-diagnostics.ts";
import {
  filesystemAuthorizationContract,
  filesystemCancellationError,
  filesystemEditDiagnosticError,
  filesystemError,
  filesystemPolicyEvaluationError,
  filesystemPolicyPathResolutionError,
  FilesystemToolError,
} from "./errors.ts";
import { lookupObservedContentHash } from "./observed-content-store.ts";
import { pathResolutionFailureDetails } from "./path-resolution-diagnostics.ts";
import { canonicalRequestPath } from "./paths.ts";

const DENIED_POLICY_SCOPES: Record<PolicyAuthorization, string> = {
  "deny-global": "the global",
  "deny-project": "the project",
  "allow-global": "a configured",
  "allow-project": "a configured",
  unknown: "a configured",
};
const BLOCKED_REASON_SUFFIXES: Record<Exclude<AuthorizationErrorKind, "denied">, string> = {
  "denied-once": " was denied for this request.",
  "not-authorized": " requires approval that is unavailable in this mode.",
  timeout: " confirmation timed out; a project deny rule was recorded.",
  confirmation: " confirmation failed.",
  save: "; the access policy could not be saved.",
  load: "; the access policy could not be loaded.",
  "invalid-choice": "; the access policy returned an invalid approval.",
  "unsafe-global": "; the access policy returned an invalid approval.",
  "unchanged-retry": " was already denied for this identical request.",
  cancelled: " confirmation was cancelled.",
  dismissed: " confirmation was dismissed.",
};

export type FilesystemAccessPolicyContext = FilesystemAuthorizationContext;

interface FilesystemToolCall {
  readonly name: "read" | "write" | "edit" | "ls" | "find" | "grep";
  readonly accesses: readonly FilesystemAccess[];
  readonly path: string | undefined;
  readonly allowMissingPath: boolean;
  readonly edits?: readonly FilesystemEditInput[];
}

function filesystemToolCall(event: ToolCallEvent): FilesystemToolCall | undefined {
  if (isToolCallEventType("read", event)) {
    return { name: "read", accesses: ["read"], path: event.input.path, allowMissingPath: false };
  }
  if (isToolCallEventType("write", event)) {
    return {
      name: "write",
      accesses: ["write"],
      path: event.input.path,
      allowMissingPath: true,
    };
  }
  if (isToolCallEventType("edit", event)) {
    return {
      name: "edit",
      accesses: ["read", "write"],
      path: event.input.path,
      allowMissingPath: false,
      edits: event.input.edits,
    };
  }
  if (isToolCallEventType("ls", event)) {
    return { name: "ls", accesses: ["read"], path: event.input.path, allowMissingPath: false };
  }
  if (isToolCallEventType("find", event)) {
    return { name: "find", accesses: ["read"], path: event.input.path, allowMissingPath: false };
  }
  if (isToolCallEventType("grep", event)) {
    return { name: "grep", accesses: ["read"], path: event.input.path, allowMissingPath: false };
  }
  return undefined;
}

function blockedReasonSuffix(kind: AuthorizationErrorKind, decision: PolicyAuthorization): string {
  if (kind === "denied") {
    return ` is denied by ${DENIED_POLICY_SCOPES[decision]} policy rule.`;
  }
  return BLOCKED_REASON_SUFFIXES[kind];
}

function blockedReason(
  tool: FilesystemToolCall,
  access: FilesystemAccess,
  path: string,
  kind: AuthorizationErrorKind,
  decision: PolicyAuthorization,
  loaded?: LoadedPolicy,
): FilesystemToolError {
  const prefix = `Tool call blocked by access policy: ${tool.name} ${access} access to "${displayPath(path)}"`;
  const message = `${prefix}${blockedReasonSuffix(kind, decision)}`;
  if (kind === "cancelled") {
    return filesystemCancellationError(message);
  }
  const denialMetadata =
    kind === "denied" &&
    loaded !== undefined &&
    (decision === "deny-global" || decision === "deny-project")
      ? filesystemPolicyDenialMetadata(loaded, access, decision)
      : undefined;
  return filesystemError(message, filesystemAuthorizationContract(kind), undefined, denialMetadata);
}

function blockedResult(
  reason: string,
  contract: ToolErrorContract,
  details?: unknown,
): ToolCallEventResult {
  return {
    block: true,
    reason: `${reason} ${JSON.stringify({
      error: contract,
      ...(details === undefined ? {} : { details }),
    })}`,
  };
}

const MAX_EDIT_PREFLIGHT_BYTES = 256_000;

async function readPreflightBytes(handle: FileHandle, buffer: Buffer, offset = 0): Promise<number> {
  if (offset >= buffer.length) return offset;
  const result = await handle.read(buffer, offset, buffer.length - offset, offset);
  if (result.bytesRead === 0) return offset;
  return readPreflightBytes(handle, buffer, offset + result.bytesRead);
}

async function readEditPreflightContent(
  path: string,
): Promise<{ content: string; contentHash: string } | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_EDIT_PREFLIGHT_BYTES) return undefined;
    const buffer = Buffer.alloc(MAX_EDIT_PREFLIGHT_BYTES + 1);
    const bytesRead = await readPreflightBytes(handle, buffer);
    if (bytesRead > MAX_EDIT_PREFLIGHT_BYTES) return undefined;
    const finalStats = await handle.stat();
    if (!finalStats.isFile() || finalStats.size !== bytesRead) return undefined;
    const bytes = buffer.subarray(0, bytesRead);
    return {
      content: bytes.toString("utf8"),
      contentHash: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    return undefined;
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
}

async function editPreflight(
  tool: FilesystemToolCall,
  path: string,
  ctx: FilesystemAccessPolicyContext,
  retryTracker: AuthorizationRetryTracker | undefined,
): Promise<ToolCallEventResult | undefined> {
  if (tool.name !== "edit" || tool.edits === undefined) return undefined;
  const signal = ctx.signal;
  if (signal?.aborted) {
    const error = filesystemCancellationError("Filesystem access policy request cancelled");
    return blockedResult(error.message, error.contract);
  }
  const preflight = await readEditPreflightContent(path);
  if (signal?.aborted) {
    const error = filesystemCancellationError("Filesystem access policy request cancelled");
    return blockedResult(error.message, error.contract);
  }
  if (preflight === undefined) return undefined;
  const { content, contentHash } = preflight;
  const sessionIdValue = ctx.sessionManager?.getSessionId();
  const sessionId =
    typeof sessionIdValue === "string" && sessionIdValue.length > 0
      ? sessionIdValue
      : "unknown-session";
  const diagnostic = diagnoseFilesystemEdits(content, tool.edits, {
    fileFingerprint: contentHash,
    observedContentHash: lookupObservedContentHash(path),
  });
  if (diagnostic === undefined) return undefined;
  const retryKey = {
    sessionId,
    surface: "filesystem-edit" as const,
    fingerprint: `${authorizationRequestFingerprint(path)}\u0000${authorizationRequestFingerprint(tool.edits)}`,
  };
  if (retryTracker !== undefined) {
    if (retryTracker.findUnchangedRetry(retryKey) !== undefined) {
      const retryError = filesystemEditDiagnosticError(
        "edit-unchanged-retry",
        `Edit preflight failed for ${displayPath(path)}: This identical edit already failed the edit preflight; reread the file and rebase the edit before retrying.`,
        { ...diagnostic },
      );
      return blockedResult(retryError.message, retryError.contract, retryError.details);
    }
    retryTracker.recordPersistentDenial(retryKey, "edit-preflight");
  }
  const error = filesystemEditDiagnosticError(
    diagnostic.code,
    `Edit preflight failed for ${displayPath(path)}: ${diagnostic.hint}`,
    { ...diagnostic },
  );
  return blockedResult(error.message, error.contract, error.details);
}

async function authorizeFilesystemAccesses(
  tool: FilesystemToolCall,
  path: string,
  loaded: LoadedPolicy,
  ctx: FilesystemAccessPolicyContext,
  policy: PolicyStore,
  observe: AuthorizationOutcomeObserver | undefined,
  retryTracker: AuthorizationRetryTracker | undefined,
): Promise<void> {
  await authorizeAndPersistFilesystemAccesses(
    tool.accesses.map((access) => ({ access, path })),
    loaded,
    ctx,
    policy,
    ctx.signal,
    {
      promptText: ({ access, path: identity }) =>
        `Authorize ${access} access for ${tool.name} to ${displayPath(identity)}?`,
      error: (kind, request, decision, currentLoaded) =>
        blockedReason(tool, request.access, request.path, kind, decision, currentLoaded),
      observe,
      retryTracker,
    },
  );
}

async function interceptFilesystemToolCall(
  event: ToolCallEvent,
  ctx: FilesystemAccessPolicyContext,
  policy: PolicyStore,
  observe: AuthorizationOutcomeObserver | undefined,
  retryTracker: AuthorizationRetryTracker | undefined,
): Promise<ToolCallEventResult | undefined> {
  const tool = filesystemToolCall(event);
  if (tool === undefined) {
    return undefined;
  }

  if (ctx.signal?.aborted) {
    const error = filesystemCancellationError("Filesystem access policy request cancelled");
    return blockedResult(error.message, error.contract);
  }

  let path: string;
  try {
    path = await canonicalRequestPath(tool.path, ctx.cwd, tool.allowMissingPath);
  } catch (error) {
    if (ctx.signal?.aborted) {
      const cancellation = filesystemCancellationError(
        "Filesystem access policy request cancelled",
      );
      return blockedResult(cancellation.message, cancellation.contract);
    }
    const resolutionError = filesystemPolicyPathResolutionError(
      pathResolutionFailureDetails(error),
    );
    return blockedResult(
      `Tool call blocked by access policy: ${tool.name} path could not be safely resolved.`,
      resolutionError.contract,
      resolutionError.details,
    );
  }

  const requestSignal = ctx.signal;
  let loaded: LoadedPolicy;
  try {
    loaded = await loadFilesystemPolicyForRequest(policy, ctx.cwd, requestSignal);
  } catch (error) {
    const cancelled = error instanceof FilesystemToolError && error.contract.code === "cancelled";
    if (!cancelled) {
      observe?.({
        outcome: "policy-load-failure",
        decisionPersisted: false,
        promptEmitted: false,
        promptWaitMs: 0,
      });
    }
    if (error instanceof FilesystemToolError) {
      return blockedResult(`Tool call blocked by access policy: ${error.message}.`, error.contract);
    }
    const fallback = filesystemPolicyEvaluationError();
    return blockedResult(
      `Tool call blocked by access policy: ${tool.name} access policy could not be loaded.`,
      fallback.contract,
    );
  }

  try {
    await authorizeFilesystemAccesses(tool, path, loaded, ctx, policy, observe, retryTracker);
  } catch (error) {
    if (error instanceof FilesystemToolError) {
      return blockedResult(error.message, error.contract, error.details);
    }
    const fallback = filesystemPolicyEvaluationError();
    return blockedResult(
      `Tool call blocked by access policy: ${tool.name} access was denied.`,
      fallback.contract,
    );
  }

  const editFailure = await editPreflight(tool, path, ctx, retryTracker);
  if (editFailure !== undefined) return editFailure;
  if (ctx.signal?.aborted) {
    const error = filesystemCancellationError("Filesystem access policy request cancelled");
    return blockedResult(error.message, error.contract);
  }
  return undefined;
}

export function createFilesystemAccessPolicyInterceptor(
  policy: PolicyStore = createPolicyStore(),
  authorizationOutcomeRecorder?: AuthorizationOutcomeRecorder,
  authorizationRetryTracker?: AuthorizationRetryTracker,
): (
  event: ToolCallEvent,
  ctx: FilesystemAccessPolicyContext,
) => Promise<ToolCallEventResult | undefined> {
  return (event, ctx) => {
    const tool = filesystemToolCall(event);
    const sessionIdValue = ctx.sessionManager?.getSessionId();
    const observe = createAuthorizationOutcomeObserver({
      surface: "filesystem",
      commandId: tool?.name,
      recorder: authorizationOutcomeRecorder,
      sessionId:
        typeof sessionIdValue === "string" && sessionIdValue.length > 0
          ? sessionIdValue
          : undefined,
      toolCallId: event.toolCallId,
      mode: ctx.mode,
      flowId: effectiveOrchestrationFlowId(readProjectCommandOrchestrationContext()),
    });
    return interceptFilesystemToolCall(event, ctx, policy, observe, authorizationRetryTracker);
  };
}
