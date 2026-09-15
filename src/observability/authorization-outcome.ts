import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { boundedIdentifier, boundedNumber, boundedOptionalIdentifier } from "./bounded.ts";
import { appendInvocationStreamRecord } from "./invocation-stream.ts";

const AUTHORIZATION_OUTCOME_FORMAT_VERSION = 1 as const;
export const AUTHORIZATION_OUTCOME_ENTRY_TYPE = "bash-tools.authorization-outcome" as const;

export type AuthorizationOutcomeSurface =
  | "project-command"
  | "verify"
  | "filesystem"
  | "environment";

/** The bounded Pi interaction modes an authorization can observe. */
export type AuthorizationInteractionMode = "tui" | "rpc" | "json" | "print";

/** Where a policy-derived outcome came from, without recording any policy contents. */
export type PolicyDecisionSource =
  | "deny-global"
  | "deny-project"
  | "allow-global"
  | "allow-project"
  | "prompt"
  | "unknown";

export type AuthorizationOutcome =
  | "policy-load-failure"
  | "decision-lookup-failure"
  | "denied"
  | "denied-once"
  | "not-authorized"
  | "confirmation-timeout"
  | "confirmation-failure"
  | "dismissed"
  | "cancelled"
  | "policy-save-failure"
  | "invalid-choice"
  | "unsafe-global"
  | "unchanged-retry-after-denial"
  | "authorized"
  | "allowed-once"
  | "allowed-and-persisted"
  | "deferred-persistence"
  | "deferred-decision-persisted";

export interface AuthorizationOutcomeCore {
  readonly outcome: AuthorizationOutcome;
  readonly decisionPersisted: boolean;
  readonly promptEmitted: boolean;
  readonly promptWaitMs: number;
  readonly executionAttempted?: boolean;
  readonly decisionSource?: PolicyDecisionSource;
}

export interface AuthorizationOutcomeRecordInput extends AuthorizationOutcomeCore {
  readonly surface: AuthorizationOutcomeSurface;
  readonly commandId?: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly mode?: AuthorizationInteractionMode;
  readonly flowId?: string;
  readonly role?: string;
  readonly delegationId?: string;
}

export interface AuthorizationOutcomeRecord {
  readonly authorizationFormatVersion: typeof AUTHORIZATION_OUTCOME_FORMAT_VERSION;
  readonly surface: AuthorizationOutcomeSurface;
  readonly commandId?: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly outcome: AuthorizationOutcome;
  readonly decisionPersisted: boolean;
  readonly promptEmitted: boolean;
  readonly promptWaitMs: number;
  readonly executionAttempted: boolean;
  readonly mode?: AuthorizationInteractionMode;
  readonly flowId?: string;
  readonly role?: string;
  readonly delegationId?: string;
  readonly decisionSource?: PolicyDecisionSource;
}

export type AuthorizationOutcomeRecorder = (record: AuthorizationOutcomeRecord) => void;

export type AuthorizationOutcomeObserver = (core: AuthorizationOutcomeCore) => void;

/** Structural slice of an orchestration context that may carry worker identity. */
export interface AuthorizationOutcomeAttribution {
  readonly orchestrated?: boolean;
  readonly role?: string;
  readonly delegationId?: string;
}

export type AuthorizationOutcomeAPI = Pick<ExtensionAPI, "appendEntry">;

function validSurface(value: unknown): AuthorizationOutcomeSurface {
  return value === "project-command" || value === "verify" || value === "filesystem"
    ? value
    : "environment";
}

function isAuthorizationOutcome(value: string): value is AuthorizationOutcome {
  return AUTHORIZATION_OUTCOMES.has(value);
}

function validInteractionMode(value: unknown): AuthorizationInteractionMode | undefined {
  switch (value) {
    case "tui":
    case "rpc":
    case "json":
    case "print":
      return value;
    default:
      return undefined;
  }
}

function validDecisionSource(value: unknown): PolicyDecisionSource | undefined {
  switch (value) {
    case "deny-global":
    case "deny-project":
    case "allow-global":
    case "allow-project":
    case "prompt":
    case "unknown":
      return value;
    default:
      return undefined;
  }
}

function validOutcome(value: unknown): AuthorizationOutcome {
  return typeof value === "string" && isAuthorizationOutcome(value)
    ? value
    : "confirmation-failure";
}

const AUTHORIZATION_OUTCOMES: ReadonlySet<string> = new Set([
  "policy-load-failure",
  "decision-lookup-failure",
  "denied",
  "denied-once",
  "not-authorized",
  "confirmation-timeout",
  "confirmation-failure",
  "dismissed",
  "cancelled",
  "policy-save-failure",
  "invalid-choice",
  "unsafe-global",
  "unchanged-retry-after-denial",
  "authorized",
  "allowed-once",
  "allowed-and-persisted",
  "deferred-persistence",
  "deferred-decision-persisted",
]);

/** Build a bounded authorization outcome record without policy contents, paths, or commands. */
export function buildAuthorizationOutcomeRecord(
  input: AuthorizationOutcomeRecordInput,
): AuthorizationOutcomeRecord {
  const commandId = typeof input.commandId === "string" ? input.commandId : undefined;
  const mode = validInteractionMode(input.mode);
  const flowId = boundedOptionalIdentifier(input.flowId);
  const role = boundedOptionalIdentifier(input.role);
  const delegationId = boundedOptionalIdentifier(input.delegationId);
  const decisionSource = validDecisionSource(input.decisionSource);
  return Object.freeze({
    authorizationFormatVersion: AUTHORIZATION_OUTCOME_FORMAT_VERSION,
    surface: validSurface(input.surface),
    ...(commandId === undefined || commandId.length === 0
      ? {}
      : { commandId: boundedIdentifier(commandId) }),
    sessionId: boundedIdentifier(input.sessionId),
    toolCallId: boundedIdentifier(input.toolCallId),
    outcome: validOutcome(input.outcome),
    decisionPersisted: input.decisionPersisted,
    promptEmitted: input.promptEmitted,
    promptWaitMs: boundedNumber(input.promptWaitMs),
    executionAttempted: input.executionAttempted === true,
    ...(mode === undefined ? {} : { mode }),
    ...(flowId === undefined ? {} : { flowId }),
    ...(role === undefined ? {} : { role }),
    ...(delegationId === undefined ? {} : { delegationId }),
    ...(decisionSource === undefined ? {} : { decisionSource }),
  });
}

/** Invoke an injected recorder without allowing observability failures to escape. */
export function recordAuthorizationOutcome(
  recorder: AuthorizationOutcomeRecorder | undefined,
  input: AuthorizationOutcomeRecordInput,
): void {
  if (recorder === undefined) return;
  try {
    recorder(buildAuthorizationOutcomeRecord(input));
  } catch {
    // A test or alternate recorder is also best effort by contract.
  }
}

/** Create a best-effort recorder backed by Pi's session custom-entry API and JSONL stream. */
export function createAuthorizationOutcomeRecorder(
  api: AuthorizationOutcomeAPI,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AuthorizationOutcomeRecorder {
  return (record) => {
    try {
      api.appendEntry(AUTHORIZATION_OUTCOME_ENTRY_TYPE, record);
    } catch {
      // Observability must never change an authorization outcome.
    }
    appendInvocationStreamRecord(record, environment);
  };
}

/** Resolve the attribution identifiers an orchestrated caller may carry onto records. */
function attributionIdentifiers(attribution: AuthorizationOutcomeAttribution | undefined): {
  readonly role?: string;
  readonly delegationId?: string;
} {
  if (attribution?.orchestrated !== true) return {};
  return {
    ...(attribution.role === undefined ? {} : { role: attribution.role }),
    ...(attribution.delegationId === undefined ? {} : { delegationId: attribution.delegationId }),
  };
}

/**
 * Create a per-call observer that fills in surface identity and emits bounded records.
 * Returns undefined when observability is inactive so authorization stays untouched.
 */
export function createAuthorizationOutcomeObserver(options: {
  readonly surface: AuthorizationOutcomeSurface;
  readonly commandId?: string;
  readonly recorder: AuthorizationOutcomeRecorder | undefined;
  readonly sessionId: string | undefined;
  readonly toolCallId: string;
  readonly mode?: AuthorizationInteractionMode;
  readonly flowId?: string;
  readonly attribution?: AuthorizationOutcomeAttribution;
}): AuthorizationOutcomeObserver | undefined {
  const { surface, commandId, recorder, sessionId, toolCallId, mode, flowId, attribution } =
    options;
  if (recorder === undefined || sessionId === undefined) return undefined;
  const { role, delegationId } = attributionIdentifiers(attribution);
  return (core) => {
    recordAuthorizationOutcome(recorder, {
      surface,
      commandId,
      sessionId,
      toolCallId,
      outcome: core.outcome,
      decisionPersisted: core.decisionPersisted,
      promptEmitted: core.promptEmitted,
      promptWaitMs: core.promptWaitMs,
      executionAttempted: core.executionAttempted,
      mode,
      flowId,
      role,
      delegationId,
      decisionSource: core.decisionSource,
    });
  };
}
