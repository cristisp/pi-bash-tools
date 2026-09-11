import type {
  AuthorizationOutcomeCore,
  AuthorizationOutcomeObserver,
  AuthorizationOutcomeSurface,
} from "../observability/authorization-outcome.ts";
import { notifySubagentApproval } from "./approval-notification.ts";
import type { AuthorizationRetryKey, AuthorizationRetryTracker } from "./authorization-retry.ts";
import { promptWithTimeout } from "./confirmation-prompt.ts";
import type {
  LoadedPolicy,
  PolicyAuthorization,
  PolicyDecision,
  PolicyDecisionRequest,
} from "./policy/types.ts";
import { readProjectCommandOrchestrationContext } from "./project-command/orchestration.ts";

const AUTHORIZATION_CHOICES = [
  "Deny once",
  "Deny globally",
  "Deny for this project",
  "Allow once",
  "Allow globally",
  "Allow for this project",
] as const;
const PROJECT_AUTHORIZATION_CHOICES = [
  "Deny once",
  "Deny for this project",
  "Allow once",
  "Allow for this project",
] as const;

type AuthorizationDecision = PolicyDecision | "deny-once" | "allow-once";

export type AuthorizationErrorKind =
  | "denied"
  | "denied-once"
  | "not-authorized"
  | "timeout"
  | "confirmation"
  | "cancelled"
  | "dismissed"
  | "save"
  | "invalid-choice"
  | "unsafe-global"
  | "load"
  | "unchanged-retry";

export interface AuthorizeOrPromptContext {
  readonly hasUI: boolean;
  readonly mode: string;
  readonly ui: {
    select(
      title: string,
      choices: readonly string[],
      options: { readonly signal: AbortSignal },
    ): Promise<string | undefined>;
    notify?(message: string, type?: "info" | "warning" | "error"): void;
  };
}

export interface AuthorizeOrPromptOptions<Identity, Request extends PolicyDecisionRequest> {
  readonly identity: Identity;
  readonly loaded: LoadedPolicy;
  readonly context: AuthorizeOrPromptContext;
  readonly signal: AbortSignal | undefined;
  readonly globalSafe: boolean;
  readonly allowGlobal?: boolean;
  readonly deferAllowPersistence: boolean;
  readonly findDecision: (loaded: LoadedPolicy, identity: Identity) => PolicyAuthorization;
  readonly recordDecisions: (
    projectPath: string,
    requests: readonly Request[],
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly makeRequest: (identity: Identity, decision: PolicyDecision) => Request;
  readonly promptText: (identity: Identity) => string;
  readonly error: (kind: AuthorizationErrorKind) => Error;
  readonly observe?: AuthorizationOutcomeObserver;
  readonly retry?: {
    readonly tracker: AuthorizationRetryTracker;
    readonly surface: AuthorizationOutcomeSurface;
    readonly sessionId: string | undefined;
    readonly fingerprint: string;
  };
}

interface PromptTiming {
  promptEmitted: boolean;
  startedAt: number | undefined;
}

function promptWaitMs(timing: PromptTiming): number {
  if (!timing.promptEmitted || timing.startedAt === undefined) return 0;
  const wait = performance.now() - timing.startedAt;
  return Number.isFinite(wait) && wait >= 0 ? Math.round(wait) : 0;
}

function retryKeyOf(
  options: Pick<AuthorizeOrPromptOptions<never, never>, "retry">,
): AuthorizationRetryKey | undefined {
  const retry = options.retry;
  if (retry === undefined || retry.sessionId === undefined) return undefined;
  return {
    sessionId: retry.sessionId,
    surface: retry.surface,
    fingerprint: retry.fingerprint,
  };
}

function recordPersistentDenial(
  retryKey: AuthorizationRetryKey | undefined,
  options: Pick<AuthorizeOrPromptOptions<never, never>, "retry">,
  reason: "denied" | "confirmation-timeout",
): void {
  if (retryKey === undefined) return;
  options.retry?.tracker.recordPersistentDenial(retryKey, reason);
}

function throwForPersistentDenial<Identity, Request extends PolicyDecisionRequest>(
  options: AuthorizeOrPromptOptions<Identity, Request>,
  timing: PromptTiming,
  retryKey: AuthorizationRetryKey | undefined,
): never {
  const unchangedRetry =
    retryKey === undefined ? undefined : options.retry?.tracker.findUnchangedRetry(retryKey);
  if (unchangedRetry !== undefined) {
    observeOutcome(options, timing, {
      outcome: "unchanged-retry-after-denial",
      decisionPersisted: false,
    });
    throw options.error("unchanged-retry");
  }
  recordPersistentDenial(retryKey, options, "denied");
  observeOutcome(options, timing, { outcome: "denied", decisionPersisted: false });
  throw options.error("denied");
}

interface OutcomeEmitter {
  readonly signal: AbortSignal | undefined;
  readonly error: (kind: AuthorizationErrorKind) => Error;
  readonly observe?: AuthorizationOutcomeObserver;
}

function observeOutcome(
  options: OutcomeEmitter,
  timing: PromptTiming,
  outcome: Omit<AuthorizationOutcomeCore, "promptEmitted" | "promptWaitMs">,
): void {
  options.observe?.({
    outcome: outcome.outcome,
    decisionPersisted: outcome.decisionPersisted,
    executionAttempted: outcome.executionAttempted,
    promptEmitted: timing.promptEmitted,
    promptWaitMs: promptWaitMs(timing),
  });
}

function observeCancelled(options: OutcomeEmitter, timing: PromptTiming): never {
  observeOutcome(options, timing, { outcome: "cancelled", decisionPersisted: false });
  throw options.error("cancelled");
}

function choiceDecision(choice: string): AuthorizationDecision {
  switch (choice) {
    case "Deny once":
      return "deny-once";
    case "Deny globally":
      return "deny-global";
    case "Deny for this project":
      return "deny-project";
    case "Allow once":
      return "allow-once";
    case "Allow globally":
      return "allow-global";
    case "Allow for this project":
      return "allow-project";
    default:
      throw new Error("invalid choice");
  }
}

function throwIfAborted(options: OutcomeEmitter, timing: PromptTiming): void {
  if (options.signal?.aborted) {
    observeCancelled(options, timing);
  }
}

async function persist<Identity, Request extends PolicyDecisionRequest>(
  options: AuthorizeOrPromptOptions<Identity, Request>,
  timing: PromptTiming,
  request: Request,
): Promise<boolean> {
  throwIfAborted(options, timing);
  try {
    await options.recordDecisions(options.loaded.projectPath, [request], options.signal);
    return true;
  } catch {
    if (options.signal?.aborted) {
      observeOutcome(options, timing, { outcome: "cancelled", decisionPersisted: false });
      throw options.error("cancelled");
    }
    return false;
  }
}

type PromptResult =
  | { readonly kind: "choice"; readonly choice: string }
  | { readonly kind: "timeout"; readonly persisted: boolean }
  | { readonly kind: "cancelled" }
  | { readonly kind: "confirmation-failure" }
  | { readonly kind: "dismissed" };

async function promptChoice<Identity, Request extends PolicyDecisionRequest>(
  options: AuthorizeOrPromptOptions<Identity, Request>,
  timing: PromptTiming,
): Promise<PromptResult> {
  timing.promptEmitted = true;
  timing.startedAt = performance.now();
  const prompt = await promptWithTimeout(
    (dialogSignal) =>
      options.context.ui.select(
        options.promptText(options.identity),
        options.allowGlobal === false ? PROJECT_AUTHORIZATION_CHOICES : AUTHORIZATION_CHOICES,
        { signal: dialogSignal },
      ),
    options.loaded.confirmationTimeoutMs,
    options.signal,
  );
  if (prompt.kind === "timeout") {
    const persisted = await persist(
      options,
      timing,
      options.makeRequest(options.identity, "deny-project"),
    );
    return { kind: "timeout", persisted };
  }
  if (prompt.kind === "cancelled") {
    return { kind: "cancelled" };
  }
  if (prompt.kind === "error") {
    return { kind: "confirmation-failure" };
  }
  if (prompt.choice === undefined) {
    return { kind: "dismissed" };
  }
  return { kind: "choice", choice: prompt.choice };
}

function notifyManualApproval(context: AuthorizeOrPromptContext): void {
  if (!readProjectCommandOrchestrationContext().orchestrated) return;
  try {
    context.ui.notify?.("Subagent is waiting for manual policy approval.", "warning");
  } catch {}
  notifySubagentApproval(context.mode);
}

async function resolvePrompt<Identity, Request extends PolicyDecisionRequest>(
  options: AuthorizeOrPromptOptions<Identity, Request>,
  timing: PromptTiming,
): Promise<Request | undefined> {
  notifyManualApproval(options.context);
  const prompt = await promptChoice(options, timing);
  switch (prompt.kind) {
    case "timeout":
      if (prompt.persisted) {
        recordPersistentDenial(retryKeyOf(options), options, "confirmation-timeout");
      }
      observeOutcome(options, timing, {
        outcome: "confirmation-timeout",
        decisionPersisted: prompt.persisted,
      });
      throw options.error(prompt.persisted ? "timeout" : "save");
    case "cancelled":
      observeOutcome(options, timing, { outcome: "cancelled", decisionPersisted: false });
      throw options.error("cancelled");
    case "confirmation-failure":
      observeOutcome(options, timing, {
        outcome: "confirmation-failure",
        decisionPersisted: false,
      });
      throw options.error("confirmation");
    case "dismissed":
      observeOutcome(options, timing, { outcome: "dismissed", decisionPersisted: false });
      throw options.error("dismissed");
    case "choice":
      break;
  }
  throwIfAborted(options, timing);
  let decision: AuthorizationDecision;
  try {
    decision = choiceDecision(prompt.choice);
  } catch {
    observeOutcome(options, timing, { outcome: "invalid-choice", decisionPersisted: false });
    throw options.error("invalid-choice");
  }
  if (decision === "deny-once") {
    observeOutcome(options, timing, { outcome: "denied-once", decisionPersisted: false });
    throw options.error("denied-once");
  }
  if (decision === "allow-once") {
    observeOutcome(options, timing, { outcome: "allowed-once", decisionPersisted: false });
    return undefined;
  }
  if (
    (decision === "allow-global" || decision === "deny-global") &&
    options.allowGlobal === false
  ) {
    observeOutcome(options, timing, { outcome: "unsafe-global", decisionPersisted: false });
    throw options.error("unsafe-global");
  }
  if (decision === "allow-global" && !options.globalSafe) {
    observeOutcome(options, timing, { outcome: "unsafe-global", decisionPersisted: false });
    throw options.error("unsafe-global");
  }
  const request = options.makeRequest(options.identity, decision);
  if (decision === "deny-global" || decision === "deny-project") {
    const persisted = await persist(options, timing, request);
    if (persisted) {
      recordPersistentDenial(retryKeyOf(options), options, "denied");
    }
    observeOutcome(options, timing, { outcome: "denied", decisionPersisted: persisted });
    if (!persisted) throw options.error("save");
    throw options.error("denied");
  }
  if (!options.deferAllowPersistence) {
    const persisted = await persist(options, timing, request);
    observeOutcome(options, timing, {
      outcome: "allowed-and-persisted",
      decisionPersisted: persisted,
    });
    if (!persisted) throw options.error("save");
    return undefined;
  }
  observeOutcome(options, timing, { outcome: "deferred-persistence", decisionPersisted: false });
  return request;
}

export async function authorizeOrPrompt<Identity, Request extends PolicyDecisionRequest>(
  options: AuthorizeOrPromptOptions<Identity, Request>,
): Promise<Request | undefined> {
  const timing: PromptTiming = { promptEmitted: false, startedAt: undefined };
  let authorization: PolicyAuthorization;
  try {
    authorization = options.findDecision(options.loaded, options.identity);
  } catch {
    observeOutcome(options, timing, {
      outcome: "decision-lookup-failure",
      decisionPersisted: false,
    });
    throw options.error("load");
  }
  if (authorization === "deny-global" || authorization === "deny-project") {
    throwForPersistentDenial(options, timing, retryKeyOf(options));
  }
  if (authorization !== "unknown") {
    observeOutcome(options, timing, { outcome: "authorized", decisionPersisted: false });
    return undefined;
  }
  throwIfAborted(options, timing);
  if (!options.context.hasUI || !["tui", "rpc"].includes(options.context.mode)) {
    observeOutcome(options, timing, { outcome: "not-authorized", decisionPersisted: false });
    throw options.error("not-authorized");
  }
  return resolvePrompt(options, timing);
}
