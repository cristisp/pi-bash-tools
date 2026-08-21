import type { AuthorizeOrPromptContext } from "../authorization.ts";
import { authorizeOrPrompt, type AuthorizationErrorKind } from "../authorization.ts";
import { findEnvironmentPolicyDecision } from "../policy/decisions.ts";
import type { EnvironmentDecisionRequest, LoadedPolicy, PolicyStore } from "../policy/types.ts";
import { EnvironmentToolError } from "./environment-schema.ts";
import type { EnvironmentToolContext } from "./environment-tool.ts";

function cancellationError(): EnvironmentToolError {
  const error = new EnvironmentToolError("Environment request cancelled");
  error.name = "AbortError";
  return error;
}

const ENVIRONMENT_AUTHORIZATION_MESSAGES: Record<
  Exclude<AuthorizationErrorKind, "cancelled" | "dismissed">,
  string
> = {
  denied: "Environment access denied by policy",
  "not-authorized": "Environment key is not authorized in this mode",
  timeout: "Environment confirmation timed out",
  confirmation: "Environment confirmation failed",
  save: "Unable to save environment policy",
  load: "Unable to load environment policy",
  "invalid-choice": "Environment confirmation returned an invalid choice",
  "unsafe-global": "Environment confirmation returned an invalid choice",
};

function errorForKind(kind: AuthorizationErrorKind): EnvironmentToolError {
  if (kind === "cancelled") {
    return cancellationError();
  }
  if (kind === "dismissed") {
    return new EnvironmentToolError("Environment confirmation cancelled");
  }
  return new EnvironmentToolError(ENVIRONMENT_AUTHORIZATION_MESSAGES[kind]);
}

function throwIfRequestAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw cancellationError();
  }
}

function persistenceError(signal: AbortSignal | undefined): EnvironmentToolError {
  if (signal?.aborted) {
    return cancellationError();
  }
  return new EnvironmentToolError("Unable to save environment policy");
}

function contextForAuthorization(ctx: EnvironmentToolContext): AuthorizeOrPromptContext {
  return ctx;
}

export async function loadEnvironmentPolicyForRequest(
  policy: PolicyStore,
  cwd: string,
  requestSignal: AbortSignal | undefined,
): Promise<LoadedPolicy> {
  throwIfRequestAborted(requestSignal);
  try {
    const loadedPolicy = await policy.load(cwd);
    throwIfRequestAborted(requestSignal);
    return loadedPolicy;
  } catch (error) {
    if (error instanceof EnvironmentToolError && error.name === "AbortError") {
      throw error;
    }
    if (requestSignal?.aborted) {
      throw cancellationError();
    }
    throw new EnvironmentToolError("Unable to load environment policy");
  }
}

export async function authorizeAndPersistEnvironmentKeys(
  keys: readonly string[],
  ctx: EnvironmentToolContext,
  loadedPolicy: LoadedPolicy,
  policy: PolicyStore,
  requestSignal: AbortSignal | undefined,
): Promise<void> {
  const staged: EnvironmentDecisionRequest[] = [];
  for (const key of keys) {
    throwIfRequestAborted(requestSignal);
    // eslint-disable-next-line no-await-in-loop
    const request = await authorizeOrPrompt<string, EnvironmentDecisionRequest>({
      identity: key,
      loaded: loadedPolicy,
      context: contextForAuthorization(ctx),
      signal: requestSignal,
      globalSafe: true,
      deferAllowPersistence: true,
      findDecision: (loaded, identity) => findEnvironmentPolicyDecision(loaded, identity),
      recordDecisions: (projectPath, requests, signal) =>
        policy.recordDecisions(projectPath, requests, signal),
      makeRequest: (identity, decision) => ({ kind: "environment", key: identity, decision }),
      promptText: (identity) => `Authorize access to environment variable ${identity}`,
      error: errorForKind,
    });
    if (request !== undefined) {
      staged.push(request);
    }
  }
  throwIfRequestAborted(requestSignal);
  if (staged.length === 0) {
    return;
  }
  try {
    await policy.recordDecisions(loadedPolicy.projectPath, staged, requestSignal);
  } catch {
    throw persistenceError(requestSignal);
  }
  throwIfRequestAborted(requestSignal);
}
