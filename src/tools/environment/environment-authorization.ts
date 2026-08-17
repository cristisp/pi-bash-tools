import type { EnvironmentToolContext } from "./environment-tool.ts";
import { EnvironmentToolError } from "./environment-schema.ts";
import {
  cancellationError,
  decisionForPromptChoice,
  promptForEnvironmentAccess,
  type EnvironmentPromptResult,
} from "./environment-prompt.ts";
import {
  type EnvironmentPolicyAuthorization,
  type EnvironmentPolicyDecisionRequest,
  type EnvironmentPolicyStore,
  type LoadedEnvironmentPolicy,
  findEnvironmentPolicyDecision,
} from "./policy.ts";

function policyLoadError(): EnvironmentToolError {
  return new EnvironmentToolError("Unable to load environment policy");
}

function policyPersistenceError(): EnvironmentToolError {
  return new EnvironmentToolError("Unable to save environment policy");
}

function unknownEnvironmentKeyError(): EnvironmentToolError {
  return new EnvironmentToolError("Environment key is not authorized in this mode");
}

async function persistEnvironmentDecisions(
  policy: EnvironmentPolicyStore,
  projectPath: string,
  decisions: readonly EnvironmentPolicyDecisionRequest[],
  requestSignal?: AbortSignal,
): Promise<void> {
  if (decisions.length === 0) {
    return;
  }
  if (requestSignal?.aborted) {
    throw cancellationError();
  }
  try {
    await policy.recordDecisions(projectPath, decisions, requestSignal);
  } catch {
    if (requestSignal?.aborted) {
      throw cancellationError();
    }
    throw policyPersistenceError();
  }
  if (requestSignal?.aborted) {
    throw cancellationError();
  }
}

function readEnvironmentAuthorization(
  loadedPolicy: LoadedEnvironmentPolicy,
  key: string,
): EnvironmentPolicyAuthorization {
  try {
    return findEnvironmentPolicyDecision(loadedPolicy, loadedPolicy.projectPath, key);
  } catch {
    throw policyLoadError();
  }
}

function requireInteractiveAuthorization(
  authorization: EnvironmentPolicyAuthorization,
  ctx: EnvironmentToolContext,
  requestSignal: AbortSignal | undefined,
): boolean {
  if (authorization === "deny-global" || authorization === "deny-project") {
    throw new EnvironmentToolError("Environment access denied by policy");
  }
  if (authorization !== "unknown") {
    return false;
  }
  if (ctx.hasUI && (ctx.mode === "tui" || ctx.mode === "rpc") && !requestSignal?.aborted) {
    return true;
  }
  throw unknownEnvironmentKeyError();
}

async function persistDeniedEnvironmentDecision(
  policy: EnvironmentPolicyStore,
  loadedPolicy: LoadedEnvironmentPolicy,
  key: string,
  decision: EnvironmentPolicyDecisionRequest["decision"],
  requestSignal: AbortSignal | undefined,
): Promise<void> {
  await persistEnvironmentDecisions(
    policy,
    loadedPolicy.projectPath,
    [{ key, decision }],
    requestSignal,
  );
}

async function resolveEnvironmentPromptDecision(
  prompt: EnvironmentPromptResult,
  policy: EnvironmentPolicyStore,
  loadedPolicy: LoadedEnvironmentPolicy,
  key: string,
  requestSignal: AbortSignal | undefined,
): Promise<EnvironmentPolicyDecisionRequest> {
  if (prompt.kind === "timeout") {
    await persistDeniedEnvironmentDecision(
      policy,
      loadedPolicy,
      key,
      "deny-project",
      requestSignal,
    );
    throw new EnvironmentToolError("Environment confirmation timed out");
  }
  if (prompt.kind === "cancelled") {
    throw cancellationError();
  }
  if (prompt.kind === "error") {
    throw new EnvironmentToolError("Environment confirmation failed");
  }
  if (prompt.choice === undefined) {
    throw new EnvironmentToolError("Environment confirmation cancelled");
  }
  if (requestSignal?.aborted) {
    throw cancellationError();
  }
  const decision = decisionForPromptChoice(prompt.choice);
  if (decision === "deny-global" || decision === "deny-project") {
    await persistDeniedEnvironmentDecision(policy, loadedPolicy, key, decision, requestSignal);
    throw new EnvironmentToolError("Environment access denied by policy");
  }
  return { key, decision };
}

async function authorizeEnvironmentKey(
  key: string,
  ctx: EnvironmentToolContext,
  loadedPolicy: LoadedEnvironmentPolicy,
  policy: EnvironmentPolicyStore,
  requestSignal: AbortSignal | undefined,
): Promise<EnvironmentPolicyDecisionRequest | undefined> {
  const authorization = readEnvironmentAuthorization(loadedPolicy, key);
  if (!requireInteractiveAuthorization(authorization, ctx, requestSignal)) {
    return undefined;
  }
  const prompt = await promptForEnvironmentAccess(
    ctx,
    key,
    loadedPolicy.confirmationTimeoutMs,
    requestSignal,
  );
  return resolveEnvironmentPromptDecision(prompt, policy, loadedPolicy, key, requestSignal);
}

async function authorizeEnvironmentKeys(
  keys: readonly string[],
  index: number,
  ctx: EnvironmentToolContext,
  loadedPolicy: LoadedEnvironmentPolicy,
  policy: EnvironmentPolicyStore,
  requestSignal: AbortSignal | undefined,
  stagedDecisions: EnvironmentPolicyDecisionRequest[],
): Promise<void> {
  const key = keys[index];
  if (key === undefined) {
    return;
  }
  if (requestSignal?.aborted) {
    throw cancellationError();
  }
  const decision = await authorizeEnvironmentKey(key, ctx, loadedPolicy, policy, requestSignal);
  if (decision !== undefined) {
    stagedDecisions.push(decision);
  }
  await authorizeEnvironmentKeys(
    keys,
    index + 1,
    ctx,
    loadedPolicy,
    policy,
    requestSignal,
    stagedDecisions,
  );
}

function throwIfRequestAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw cancellationError();
  }
}

export async function loadEnvironmentPolicyForRequest(
  policy: EnvironmentPolicyStore,
  cwd: string,
  requestSignal: AbortSignal | undefined,
): Promise<LoadedEnvironmentPolicy> {
  throwIfRequestAborted(requestSignal);
  try {
    const loadedPolicy = await policy.load(cwd);
    throwIfRequestAborted(requestSignal);
    return loadedPolicy;
  } catch (error) {
    if (error instanceof EnvironmentToolError && error.name === "AbortError") {
      throw error;
    }
    throw policyLoadError();
  }
}

export async function authorizeAndPersistEnvironmentKeys(
  keys: readonly string[],
  ctx: EnvironmentToolContext,
  loadedPolicy: LoadedEnvironmentPolicy,
  policy: EnvironmentPolicyStore,
  requestSignal: AbortSignal | undefined,
): Promise<void> {
  const stagedDecisions: EnvironmentPolicyDecisionRequest[] = [];
  await authorizeEnvironmentKeys(
    keys,
    0,
    ctx,
    loadedPolicy,
    policy,
    requestSignal,
    stagedDecisions,
  );
  throwIfRequestAborted(requestSignal);
  await persistEnvironmentDecisions(
    policy,
    loadedPolicy.projectPath,
    stagedDecisions,
    requestSignal,
  );
  throwIfRequestAborted(requestSignal);
}
