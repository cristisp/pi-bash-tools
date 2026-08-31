import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { authorizeOrPrompt, type AuthorizationErrorKind } from "../authorization.ts";
import { displayPath } from "../path-display.ts";
import { findFilesystemPolicyDecision } from "../policy/decisions.ts";
import type {
  FilesystemAccess,
  FilesystemDecisionRequest,
  LoadedPolicy,
  PolicyAuthorization,
  PolicyStore,
} from "../policy/types.ts";
import {
  filesystemCancellationError,
  FilesystemToolError,
  filesystemPolicyLoadError,
} from "./errors.ts";

export type FilesystemAuthorizationContext = Omit<
  Pick<ExtensionContext, "cwd" | "signal" | "hasUI" | "mode" | "ui">,
  "ui"
> & {
  readonly ui: Pick<ExtensionContext["ui"], "select">;
};

export interface FilesystemAuthorizationRequest {
  readonly access: FilesystemAccess;
  readonly path: string;
  readonly policyPath?: string;
}

export type FilesystemAuthorizationError = (
  kind: AuthorizationErrorKind,
  request: FilesystemAuthorizationRequest,
  decision: PolicyAuthorization,
) => Error;

export interface FilesystemAuthorizationOptions {
  readonly allowGlobal?: boolean;
  readonly defaultAllow?: (request: FilesystemAuthorizationRequest) => Promise<boolean>;
  readonly promptText?: (request: FilesystemAuthorizationRequest) => string;
  readonly error: FilesystemAuthorizationError;
}

function cancellationError(): FilesystemToolError {
  return filesystemCancellationError("Filesystem access policy request cancelled");
}

function throwIfRequestAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw cancellationError();
  }
}

export async function loadFilesystemPolicyForRequest(
  policy: PolicyStore,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<LoadedPolicy> {
  throwIfRequestAborted(signal);
  try {
    const loaded = await policy.load(cwd);
    throwIfRequestAborted(signal);
    return loaded;
  } catch (error) {
    if (error instanceof FilesystemToolError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw cancellationError();
    }
    if (signal?.aborted) {
      throw cancellationError();
    }
    throw filesystemPolicyLoadError();
  }
}

async function authorizeFilesystemAccess(
  request: FilesystemAuthorizationRequest,
  loaded: LoadedPolicy,
  ctx: FilesystemAuthorizationContext,
  policy: PolicyStore,
  signal: AbortSignal | undefined,
  options: FilesystemAuthorizationOptions,
): Promise<FilesystemDecisionRequest | undefined> {
  const policyPath = request.policyPath ?? request.path;
  const defaultAllowed = (await options.defaultAllow?.(request)) ?? false;
  let matchedDecision: PolicyAuthorization = "unknown";
  return authorizeOrPrompt<string, FilesystemDecisionRequest>({
    identity: policyPath,
    loaded,
    context: ctx,
    signal,
    globalSafe: true,
    allowGlobal: options.allowGlobal,
    deferAllowPersistence: true,
    findDecision: (current, identity) => {
      matchedDecision = findFilesystemPolicyDecision(current, request.path, request.access);
      if (matchedDecision === "unknown" && identity !== request.path) {
        matchedDecision = findFilesystemPolicyDecision(current, identity, request.access);
      }
      return matchedDecision === "unknown" && defaultAllowed ? "allow-project" : matchedDecision;
    },
    recordDecisions: (projectPath, requests, requestSignal) =>
      policy.recordDecisions(projectPath, requests, requestSignal),
    makeRequest: (identity, decision) => ({
      kind: "filesystem",
      access: request.access,
      path: identity,
      decision,
    }),
    promptText: (identity) =>
      options.promptText?.(request) ??
      `Authorize ${request.access} access to ${displayPath(identity)}?`,
    error: (kind) => options.error(kind, request, matchedDecision),
  });
}

async function collectFilesystemDecisions(
  requests: readonly FilesystemAuthorizationRequest[],
  index: number,
  loaded: LoadedPolicy,
  ctx: FilesystemAuthorizationContext,
  policy: PolicyStore,
  signal: AbortSignal | undefined,
  options: FilesystemAuthorizationOptions,
  deferred: FilesystemDecisionRequest[],
): Promise<void> {
  if (index >= requests.length) {
    return;
  }
  throwIfRequestAborted(signal);
  const request = await authorizeFilesystemAccess(
    requests[index],
    loaded,
    ctx,
    policy,
    signal,
    options,
  );
  if (request !== undefined) {
    deferred.push(request);
  }
  await collectFilesystemDecisions(
    requests,
    index + 1,
    loaded,
    ctx,
    policy,
    signal,
    options,
    deferred,
  );
}

export async function authorizeAndPersistFilesystemAccesses(
  requests: readonly FilesystemAuthorizationRequest[],
  loaded: LoadedPolicy,
  ctx: FilesystemAuthorizationContext,
  policy: PolicyStore,
  signal: AbortSignal | undefined,
  options: FilesystemAuthorizationOptions,
): Promise<void> {
  const deferred: FilesystemDecisionRequest[] = [];
  await collectFilesystemDecisions(requests, 0, loaded, ctx, policy, signal, options, deferred);
  throwIfRequestAborted(signal);
  if (deferred.length === 0) {
    return;
  }
  try {
    await policy.recordDecisions(loaded.projectPath, deferred, signal);
  } catch {
    const request = requests[0];
    if (request === undefined) {
      throw options.error("save", { access: "write", path: loaded.projectPath }, "unknown");
    }
    throw options.error(signal?.aborted ? "cancelled" : "save", request, "unknown");
  }
  throwIfRequestAborted(signal);
}
