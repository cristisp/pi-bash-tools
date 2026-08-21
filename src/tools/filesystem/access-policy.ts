import {
  isToolCallEventType,
  type ToolCallEvent,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { type AuthorizationErrorKind } from "../authorization.ts";
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
import { canonicalRequestPath } from "./paths.ts";

const DENIED_POLICY_SCOPES: Record<PolicyAuthorization, string> = {
  "deny-global": "the global",
  "deny-project": "the project",
  "allow-global": "a configured",
  "allow-project": "a configured",
  unknown: "a configured",
};
const BLOCKED_REASON_SUFFIXES: Record<Exclude<AuthorizationErrorKind, "denied">, string> = {
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
): Error {
  const prefix = `Tool call blocked by access policy: ${tool.name} ${access} access to "${displayPath(path)}"`;
  return new Error(`${prefix}${blockedReasonSuffix(kind, decision)}`);
}

function blockedResult(reason: string): ToolCallEventResult {
  return { block: true, reason };
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
      error: (kind, request, decision) =>
        blockedReason(tool, request.access, request.path, kind, decision),
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

  let path: string;
  try {
    path = await canonicalRequestPath(tool.path, ctx.cwd, tool.allowMissingPath);
  } catch {
    return blockedResult(
      `Tool call blocked by access policy: ${tool.name} path could not be safely resolved.`,
    );
  }

  const requestSignal = ctx.signal;
  let loaded: LoadedPolicy;
  try {
    loaded = await loadFilesystemPolicyForRequest(policy, ctx.cwd, requestSignal);
  } catch (error) {
    return blockedResult(
      error instanceof Error
        ? `Tool call blocked by access policy: ${error.message}.`
        : `Tool call blocked by access policy: ${tool.name} access policy could not be loaded.`,
    );
  }

  try {
    await authorizeFilesystemAccesses(tool, path, loaded, ctx, policy);
  } catch (error) {
    return blockedResult(
      error instanceof Error
        ? error.message
        : `Tool call blocked by access policy: ${tool.name} access was denied.`,
    );
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
