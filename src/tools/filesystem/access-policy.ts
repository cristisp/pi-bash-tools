import {
  isToolCallEventType,
  type ToolCallEvent,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { open, type FileHandle } from "node:fs/promises";
import { type AuthorizationErrorKind } from "../authorization.ts";
import type { ToolErrorContract } from "../errors.ts";
import { displayPath } from "../path-display.ts";
import { createPolicyStore } from "../policy/store.ts";
import type {
  FilesystemAccess,
  LoadedPolicy,
  PolicyAuthorization,
  PolicyStore,
} from "../policy/types.ts";
import {
  authorizeAndPersistFilesystemAccesses,
  loadFilesystemPolicyForRequest,
  type FilesystemAuthorizationContext,
} from "./authorization.ts";
import { filesystemPolicyDenialMetadata } from "../policy/decisions.ts";
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

async function readEditPreflightContent(path: string): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_EDIT_PREFLIGHT_BYTES) return undefined;
    const buffer = Buffer.alloc(MAX_EDIT_PREFLIGHT_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_EDIT_PREFLIGHT_BYTES) return undefined;
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
}

async function editPreflight(
  tool: FilesystemToolCall,
  path: string,
  signal: AbortSignal | undefined,
): Promise<ToolCallEventResult | undefined> {
  if (tool.name !== "edit" || tool.edits === undefined) return undefined;
  if (signal?.aborted) {
    const error = filesystemCancellationError("Filesystem access policy request cancelled");
    return blockedResult(error.message, error.contract);
  }
  const content = await readEditPreflightContent(path);
  if (signal?.aborted) {
    const error = filesystemCancellationError("Filesystem access policy request cancelled");
    return blockedResult(error.message, error.contract);
  }
  if (content === undefined) return undefined;
  const diagnostic = diagnoseFilesystemEdits(content, tool.edits);
  if (diagnostic === undefined) return undefined;
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
    },
  );
}

async function interceptFilesystemToolCall(
  event: ToolCallEvent,
  ctx: FilesystemAccessPolicyContext,
  policy: PolicyStore,
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
  } catch {
    const error = ctx.signal?.aborted
      ? filesystemCancellationError("Filesystem access policy request cancelled")
      : filesystemPolicyPathResolutionError();
    return blockedResult(
      ctx.signal?.aborted
        ? error.message
        : `Tool call blocked by access policy: ${tool.name} path could not be safely resolved.`,
      error.contract,
    );
  }

  const requestSignal = ctx.signal;
  let loaded: LoadedPolicy;
  try {
    loaded = await loadFilesystemPolicyForRequest(policy, ctx.cwd, requestSignal);
  } catch (error) {
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
    await authorizeFilesystemAccesses(tool, path, loaded, ctx, policy);
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

  const editFailure = await editPreflight(tool, path, ctx.signal);
  if (editFailure !== undefined) return editFailure;
  if (ctx.signal?.aborted) {
    const error = filesystemCancellationError("Filesystem access policy request cancelled");
    return blockedResult(error.message, error.contract);
  }
  return undefined;
}

export function createFilesystemAccessPolicyInterceptor(
  policy: PolicyStore = createPolicyStore(),
): (
  event: ToolCallEvent,
  ctx: FilesystemAccessPolicyContext,
) => Promise<ToolCallEventResult | undefined> {
  return (event, ctx) => interceptFilesystemToolCall(event, ctx, policy);
}
