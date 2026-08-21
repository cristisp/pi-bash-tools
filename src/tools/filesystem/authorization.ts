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

export type FilesystemAuthorizationContext = Omit<
  Pick<ExtensionContext, "cwd" | "signal" | "hasUI" | "mode" | "ui">,
  "ui"
> & {
  readonly ui: Pick<ExtensionContext["ui"], "select">;
};

export interface FilesystemAuthorizationRequest {
  readonly access: FilesystemAccess;
  readonly path: string;
}

export type FilesystemAuthorizationError = (
  kind: AuthorizationErrorKind,
  request: FilesystemAuthorizationRequest,
  decision: PolicyAuthorization,
) => Error;

export interface FilesystemAuthorizationOptions {
  readonly promptText?: (request: FilesystemAuthorizationRequest) => string;
  readonly error: FilesystemAuthorizationError;
}

function cancellationError(): Error {
  const error = new Error("Filesystem access policy request cancelled");
  error.name = "AbortError";
  return error;
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
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    if (signal?.aborted) {
      throw cancellationError();
    }
    throw new Error("Unable to load filesystem access policy", { cause: error });
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
  let matchedDecision: PolicyAuthorization = "unknown";
  return authorizeOrPrompt<string, FilesystemDecisionRequest>({
    identity: request.path,
    loaded,
    context: ctx,
    signal,
    globalSafe: true,
    deferAllowPersistence: true,
    findDecision: (current, identity) => {
      matchedDecision = findFilesystemPolicyDecision(current, identity, request.access);
      return matchedDecision;
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
