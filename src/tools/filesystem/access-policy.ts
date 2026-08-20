import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  isToolCallEventType,
  type ExtensionContext,
  type ToolCallEvent,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { authorizeOrPrompt, type AuthorizationErrorKind } from "../authorization.ts";
import { displayPath } from "../path-display.ts";
import { findFilesystemPolicyDecision } from "../policy/decisions.ts";
import { createPolicyStore } from "../policy/store.ts";
import type {
  FilesystemDecisionRequest,
  LoadedPolicy,
  PolicyAuthorization,
  PolicyStore,
} from "../policy/types.ts";
import { validatePolicyPath } from "../policy/format.ts";

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

export type FilesystemAccessPolicyContext = Omit<
  Pick<ExtensionContext, "cwd" | "signal" | "hasUI" | "mode" | "ui">,
  "ui"
> & {
  readonly ui: Pick<ExtensionContext["ui"], "select">;
};

interface FilesystemToolCall {
  readonly name: "ls" | "find" | "grep";
  readonly path: string | undefined;
}

function filesystemToolCall(event: ToolCallEvent): FilesystemToolCall | undefined {
  if (isToolCallEventType("ls", event)) {
    return { name: "ls", path: event.input.path };
  }
  if (isToolCallEventType("find", event)) {
    return { name: "find", path: event.input.path };
  }
  if (isToolCallEventType("grep", event)) {
    return { name: "grep", path: event.input.path };
  }
  return undefined;
}

function requestPath(path: string | undefined, cwd: string): string {
  const supplied = path === undefined || path.length === 0 ? "." : path;
  const normalized = supplied.startsWith("@") ? supplied.slice(1) || "." : supplied;
  return resolve(cwd, normalized);
}

async function canonicalRequestPath(path: string | undefined, cwd: string): Promise<string> {
  const canonical = await realpath(requestPath(path, cwd));
  return validatePolicyPath(canonical);
}

function blockedReasonSuffix(kind: AuthorizationErrorKind, decision: PolicyAuthorization): string {
  if (kind === "denied") {
    return ` is denied by ${DENIED_POLICY_SCOPES[decision]} policy rule.`;
  }
  return BLOCKED_REASON_SUFFIXES[kind];
}

function blockedReason(
  name: FilesystemToolCall["name"],
  path: string,
  kind: AuthorizationErrorKind,
  decision: PolicyAuthorization,
): Error {
  const prefix = `Tool call blocked by access policy: ${name} access to "${displayPath(path)}"`;
  return new Error(`${prefix}${blockedReasonSuffix(kind, decision)}`);
}

function blockedResult(reason: string): ToolCallEventResult {
  return { block: true, reason };
}

async function loadPolicy(
  policy: PolicyStore,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<LoadedPolicy> {
  if (signal?.aborted) {
    throw new Error("Filesystem access policy request cancelled");
  }
  try {
    const loaded = await policy.load(cwd);
    if (signal?.aborted) {
      throw new Error("Filesystem access policy request cancelled");
    }
    return loaded;
  } catch (error) {
    if (error instanceof Error && error.message === "Filesystem access policy request cancelled") {
      throw error;
    }
    throw new Error("Unable to load filesystem access policy", { cause: error });
  }
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
    path = await canonicalRequestPath(tool.path, ctx.cwd);
  } catch {
    return blockedResult(
      `Tool call blocked by access policy: ${tool.name} path could not be safely resolved.`,
    );
  }

  const requestSignal = ctx.signal;
  let loaded: LoadedPolicy;
  try {
    loaded = await loadPolicy(policy, ctx.cwd, requestSignal);
  } catch (error) {
    return blockedResult(
      error instanceof Error
        ? `Tool call blocked by access policy: ${error.message}.`
        : `Tool call blocked by access policy: ${tool.name} access policy could not be loaded.`,
    );
  }

  let matchedDecision: PolicyAuthorization = "unknown";
  try {
    await authorizeOrPrompt<string, FilesystemDecisionRequest>({
      identity: path,
      loaded,
      context: ctx,
      signal: requestSignal,
      globalSafe: true,
      deferAllowPersistence: false,
      findDecision: (current, identity) => {
        matchedDecision = findFilesystemPolicyDecision(current, identity);
        return matchedDecision;
      },
      recordDecisions: (projectPath, requests, signal) =>
        policy.recordDecisions(projectPath, requests, signal),
      makeRequest: (identity, decision) => ({ kind: "filesystem", path: identity, decision }),
      promptText: (identity) => `Authorize ${tool.name} access to ${displayPath(identity)}?`,
      error: (kind) => blockedReason(tool.name, path, kind, matchedDecision),
    });
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
