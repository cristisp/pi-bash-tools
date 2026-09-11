import type { AuthorizationOutcomeObserver } from "../../observability/authorization-outcome.ts";
import type { AuthorizationRetryTracker } from "../authorization-retry.ts";
import { authorizationRequestFingerprint } from "../authorization-retry.ts";
import type { AuthorizeOrPromptContext } from "../authorization.ts";
import { authorizeOrPrompt, type AuthorizationErrorKind } from "../authorization.ts";
import { findEnvironmentPolicyDecision } from "../policy/decisions.ts";
import type { EnvironmentDecisionRequest, LoadedPolicy, PolicyStore } from "../policy/types.ts";
import {
  environmentCancellationError,
  environmentContract,
  environmentError,
  EnvironmentToolError,
} from "./environment-schema.ts";
import type { EnvironmentToolContext } from "./environment-tool.ts";

function cancellationError(): EnvironmentToolError {
  return environmentCancellationError();
}

const ENVIRONMENT_AUTHORIZATION_MESSAGES: Record<
  Exclude<AuthorizationErrorKind, "cancelled" | "dismissed">,
  string
> = {
  denied: "Environment access denied by policy",
  "denied-once": "Environment access denied for this request",
  "not-authorized": "Environment key is not authorized in this mode",
  timeout: "Environment confirmation timed out",
  confirmation: "Environment confirmation failed",
  save: "Unable to save environment policy",
  load: "Unable to load environment policy",
  "invalid-choice": "Environment confirmation returned an invalid choice",
  "unsafe-global": "Environment confirmation returned an invalid choice",
  "unchanged-retry":
    "Environment access was already denied for this identical request; change the request or ask the user to approve it explicitly",
};

function authorizationContract(kind: Exclude<AuthorizationErrorKind, "cancelled" | "dismissed">) {
  const blocked =
    kind === "denied" ||
    kind === "denied-once" ||
    kind === "not-authorized" ||
    kind === "unsafe-global" ||
    kind === "unchanged-retry";
  const timeout = kind === "timeout";
  const code = timeout
    ? "confirmation-timeout"
    : kind === "confirmation"
      ? "policy-confirmation-failure"
      : kind === "save"
        ? "policy-save-failure"
        : kind === "load"
          ? "policy-evaluation-failure"
          : kind === "invalid-choice"
            ? "policy-invalid-choice"
            : `policy-${kind}`;
  return environmentContract(
    code,
    blocked ? "BLOCKED" : timeout ? "TIMEOUT" : "POLICY_FAILURE",
    ENVIRONMENT_AUTHORIZATION_MESSAGES[kind],
    timeout || !blocked,
    false,
  );
}

function errorForKind(kind: AuthorizationErrorKind): EnvironmentToolError {
  if (kind === "cancelled") {
    return cancellationError();
  }
  if (kind === "dismissed") {
    return environmentError(
      "Environment confirmation cancelled",
      environmentContract(
        "policy-confirmation-failure",
        "POLICY_FAILURE",
        "Environment confirmation was dismissed.",
        true,
        false,
      ),
    );
  }
  return environmentError(ENVIRONMENT_AUTHORIZATION_MESSAGES[kind], authorizationContract(kind));
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
  return environmentError(
    "Unable to save environment policy",
    environmentContract(
      "policy-save-failure",
      "POLICY_FAILURE",
      "The environment policy could not be saved.",
      true,
      false,
    ),
  );
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
    throw environmentError(
      "Unable to load environment policy",
      environmentContract(
        "policy-load-failure",
        "POLICY_FAILURE",
        "The environment policy could not be loaded.",
        true,
        false,
      ),
    );
  }
}

export async function authorizeAndPersistEnvironmentKeys(
  keys: readonly string[],
  ctx: EnvironmentToolContext,
  loadedPolicy: LoadedPolicy,
  policy: PolicyStore,
  requestSignal: AbortSignal | undefined,
  observe: AuthorizationOutcomeObserver | undefined,
  retryTracker: AuthorizationRetryTracker | undefined,
): Promise<void> {
  const staged: EnvironmentDecisionRequest[] = [];
  const sessionIdValue = ctx.sessionManager?.getSessionId();
  const sessionId =
    typeof sessionIdValue === "string" && sessionIdValue.length > 0 ? sessionIdValue : undefined;
  for (const key of keys) {
    throwIfRequestAborted(requestSignal);
    const fingerprint = authorizationRequestFingerprint({ kind: "environment", key });
    // eslint-disable-next-line no-await-in-loop
    const request = await authorizeOrPrompt<string, EnvironmentDecisionRequest>({
      identity: key,
      loaded: loadedPolicy,
      context: contextForAuthorization(ctx),
      signal: requestSignal,
      globalSafe: true,
      deferAllowPersistence: true,
      retry:
        retryTracker === undefined
          ? undefined
          : { tracker: retryTracker, surface: "environment", sessionId, fingerprint },
      findDecision: (loaded, identity) => findEnvironmentPolicyDecision(loaded, identity),
      recordDecisions: (projectPath, requests, signal) =>
        policy.recordDecisions(projectPath, requests, signal),
      makeRequest: (identity, decision) => ({ kind: "environment", key: identity, decision }),
      promptText: (identity) => `Authorize access to environment variable ${identity}`,
      error: errorForKind,
      observe,
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
    observe?.({
      outcome: requestSignal?.aborted ? "cancelled" : "policy-save-failure",
      decisionPersisted: false,
      promptEmitted: false,
      promptWaitMs: 0,
    });
    throw persistenceError(requestSignal);
  }
  observe?.({
    outcome: "deferred-decision-persisted",
    decisionPersisted: true,
    promptEmitted: false,
    promptWaitMs: 0,
  });
  throwIfRequestAborted(requestSignal);
}
