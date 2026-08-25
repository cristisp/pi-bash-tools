import { promptWithTimeout } from "./confirmation-prompt.ts";
import type {
  LoadedPolicy,
  PolicyAuthorization,
  PolicyDecision,
  PolicyDecisionRequest,
} from "./policy/types.ts";

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
  | "load";

export interface AuthorizeOrPromptContext {
  readonly hasUI: boolean;
  readonly mode: string;
  readonly ui: {
    select(
      title: string,
      choices: readonly string[],
      options: { readonly signal: AbortSignal },
    ): Promise<string | undefined>;
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

function throwIfAborted<Identity, Request extends PolicyDecisionRequest>(
  options: AuthorizeOrPromptOptions<Identity, Request>,
): void {
  if (options.signal?.aborted) {
    throw options.error("cancelled");
  }
}

async function persist<Identity, Request extends PolicyDecisionRequest>(
  options: AuthorizeOrPromptOptions<Identity, Request>,
  request: Request,
): Promise<void> {
  throwIfAborted(options);
  try {
    await options.recordDecisions(options.loaded.projectPath, [request], options.signal);
  } catch {
    if (options.signal?.aborted) {
      throw options.error("cancelled");
    }
    throw options.error("save");
  }
  throwIfAborted(options);
}

async function promptChoice<Identity, Request extends PolicyDecisionRequest>(
  options: AuthorizeOrPromptOptions<Identity, Request>,
): Promise<string> {
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
    await persist(options, options.makeRequest(options.identity, "deny-project"));
    throw options.error("timeout");
  }
  if (prompt.kind === "cancelled") {
    throw options.error("cancelled");
  }
  if (prompt.kind === "error") {
    throw options.error("confirmation");
  }
  if (prompt.choice === undefined) {
    throw options.error("dismissed");
  }
  return prompt.choice;
}

async function resolvePrompt<Identity, Request extends PolicyDecisionRequest>(
  options: AuthorizeOrPromptOptions<Identity, Request>,
): Promise<Request | undefined> {
  const choice = await promptChoice(options);
  throwIfAborted(options);
  let decision: AuthorizationDecision;
  try {
    decision = choiceDecision(choice);
  } catch {
    throw options.error("invalid-choice");
  }
  if (decision === "deny-once") {
    throw options.error("denied-once");
  }
  if (decision === "allow-once") {
    return undefined;
  }
  if (
    (decision === "allow-global" || decision === "deny-global") &&
    options.allowGlobal === false
  ) {
    throw options.error("unsafe-global");
  }
  if (decision === "allow-global" && !options.globalSafe) {
    throw options.error("unsafe-global");
  }
  const request = options.makeRequest(options.identity, decision);
  if (decision === "deny-global" || decision === "deny-project") {
    await persist(options, request);
    throw options.error("denied");
  }
  if (!options.deferAllowPersistence) {
    await persist(options, request);
    return undefined;
  }
  return request;
}

export async function authorizeOrPrompt<Identity, Request extends PolicyDecisionRequest>(
  options: AuthorizeOrPromptOptions<Identity, Request>,
): Promise<Request | undefined> {
  let authorization: PolicyAuthorization;
  try {
    authorization = options.findDecision(options.loaded, options.identity);
  } catch {
    throw options.error("load");
  }
  if (authorization === "deny-global" || authorization === "deny-project") {
    throw options.error("denied");
  }
  if (authorization !== "unknown") {
    return undefined;
  }
  throwIfAborted(options);
  if (!options.context.hasUI || !["tui", "rpc"].includes(options.context.mode)) {
    throw options.error("not-authorized");
  }
  return resolvePrompt(options);
}
