import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { authorizeOrPrompt, type AuthorizationErrorKind } from "../authorization.ts";
import { findProjectCommandPolicyDecision } from "../policy/decisions.ts";
import type { CommandIdentity, PolicyStore } from "../policy/types.ts";
import { projectCommandIdentity, type ProjectCommandDefinition } from "./definitions.ts";
import type { ProjectCommandExecutionOutcome } from "./execution.ts";
import {
  createExecutionFailure,
  createResolutionFailure,
  displayCommand,
  outputDetails,
  type ProjectCommandOutputDetails,
  type ProjectCommandRequestParameters,
} from "./output.ts";
import { isProjectCommandResolutionError } from "./resolution.ts";
import type { ProjectCommandResolver, ResolvedProjectCommand } from "./resolution/types.ts";
import {
  cancellationError,
  type ProjectCommandInputFor,
  ProjectCommandToolError,
  validateProjectCommandInput,
} from "./schema.ts";

export type ProjectCommandToolContext = Omit<
  Pick<ExtensionContext, "cwd" | "signal" | "hasUI" | "mode" | "ui">,
  "ui"
> & {
  readonly ui: Pick<ExtensionContext["ui"], "select">;
};

export type ProjectCommandExecutor = (
  resolved: ResolvedProjectCommand,
  cwd: string,
  signal: AbortSignal | undefined,
) => Promise<ProjectCommandExecutionOutcome>;

export type ProjectCommandExecute<Definitions extends readonly ProjectCommandDefinition[]> = (
  toolCallId: string,
  params: ProjectCommandInputFor<Definitions>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<ProjectCommandOutputDetails> | undefined,
  ctx: ProjectCommandToolContext,
) => Promise<AgentToolResult<ProjectCommandOutputDetails>>;

function result(
  details: ProjectCommandOutputDetails,
): AgentToolResult<ProjectCommandOutputDetails> {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  };
}

async function resolveCommandForTool(
  resolver: ProjectCommandResolver,
  definition: ProjectCommandDefinition,
  projectPath: string,
  signal: AbortSignal | undefined,
  params: ProjectCommandRequestParameters,
): Promise<ResolvedProjectCommand> {
  try {
    return await resolver(definition, projectPath, signal, params);
  } catch (error) {
    if (isProjectCommandResolutionError(error)) {
      throw createResolutionFailure(params, error);
    }
    throw error;
  }
}

function commandCancellationError(): ProjectCommandToolError {
  return cancellationError();
}

const PROJECT_COMMAND_AUTHORIZATION_MESSAGES: Record<
  Exclude<AuthorizationErrorKind, "cancelled" | "dismissed">,
  string
> = {
  denied: "Project command denied by policy",
  "not-authorized": "Project command is not authorized in this mode",
  timeout: "Project command confirmation timed out",
  confirmation: "Project command confirmation failed",
  save: "Unable to save project command policy",
  "unsafe-global": "Project command cannot be allowed globally",
  "invalid-choice": "Project command confirmation returned an invalid choice",
  load: "Unable to load project command policy",
};

function authorizationError(kind: AuthorizationErrorKind): ProjectCommandToolError {
  if (kind === "cancelled" || kind === "dismissed") {
    return commandCancellationError();
  }
  return new ProjectCommandToolError(PROJECT_COMMAND_AUTHORIZATION_MESSAGES[kind]);
}

function throwIfRequestAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw commandCancellationError();
  }
}

async function loadPolicy(policy: PolicyStore, cwd: string, signal: AbortSignal | undefined) {
  throwIfRequestAborted(signal);
  try {
    const loaded = await policy.load(cwd);
    throwIfRequestAborted(signal);
    return loaded;
  } catch (error) {
    if (error instanceof ProjectCommandToolError && error.name === "AbortError") {
      throw error;
    }
    if (signal?.aborted) {
      throw commandCancellationError();
    }
    throw new ProjectCommandToolError("Unable to load project command policy");
  }
}

async function authorizeCommand(
  policy: PolicyStore,
  loaded: Awaited<ReturnType<PolicyStore["load"]>>,
  definition: ProjectCommandDefinition,
  identity: CommandIdentity,
  resolved: ResolvedProjectCommand,
  ctx: ProjectCommandToolContext,
  signal: AbortSignal | undefined,
): Promise<void> {
  await authorizeOrPrompt<
    CommandIdentity,
    Extract<import("../policy/types.ts").PolicyDecisionRequest, { kind: "project-command" }>
  >({
    identity,
    loaded,
    context: ctx,
    signal,
    globalSafe: definition.globalSafe,
    deferAllowPersistence: false,
    findDecision: (current, currentIdentity) =>
      findProjectCommandPolicyDecision(current, currentIdentity, definition.globalSafe),
    recordDecisions: (projectPath, requests, requestSignal) =>
      policy.recordDecisions(projectPath, requests, requestSignal),
    makeRequest: (currentIdentity, decision) => ({
      kind: "project-command",
      identity: currentIdentity,
      decision,
      globalSafe: definition.globalSafe,
    }),
    promptText: (currentIdentity) =>
      `Authorize project command ${currentIdentity.commandId}: ${displayCommand(resolved)}${
        resolved.script === undefined ? "" : `\nScript: ${resolved.script}`
      }`,
    error: authorizationError,
  });
}

function failureOutcome(): ProjectCommandExecutionOutcome {
  return {
    status: "spawn-failure",
    exit: { code: null, signal: null },
    timedOut: false,
    cancelled: false,
    stdout: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
    stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
  };
}

async function executeAuthorizedCommand(
  executor: ProjectCommandExecutor,
  resolved: ResolvedProjectCommand,
  projectPath: string,
  signal: AbortSignal | undefined,
): Promise<ProjectCommandExecutionOutcome> {
  try {
    return await executor(resolved, projectPath, signal);
  } catch {
    return failureOutcome();
  }
}

function hasAcceptedExitCode(
  resolved: ResolvedProjectCommand,
  outcome: ProjectCommandExecutionOutcome,
): boolean {
  return (
    outcome.status === "nonzero" &&
    outcome.exit.code !== null &&
    (resolved.definition.acceptedExitCodes?.includes(outcome.exit.code) ?? false)
  );
}

export function createProjectCommandExecute<
  const Definitions extends readonly ProjectCommandDefinition[],
>(
  policy: PolicyStore,
  executor: ProjectCommandExecutor,
  resolver: ProjectCommandResolver,
  capturedDefinitions: Definitions,
  byId: ReadonlyMap<string, ProjectCommandDefinition>,
): ProjectCommandExecute<Definitions> {
  return async (_toolCallId, rawParams, signal, _onUpdate, ctx) => {
    const params = validateProjectCommandInput(
      rawParams,
      capturedDefinitions,
    ) as ProjectCommandInputFor<Definitions>;
    const definition = byId.get(params.commandId);
    if (definition === undefined) {
      throw new ProjectCommandToolError("Project command request is invalid");
    }
    const requestSignal = signal ?? ctx.signal;
    const loaded = await loadPolicy(policy, ctx.cwd, requestSignal);
    const resolved = await resolveCommandForTool(
      resolver,
      definition,
      loaded.projectPath,
      requestSignal,
      params,
    );
    throwIfRequestAborted(requestSignal);
    const identity = projectCommandIdentity(definition, resolved);
    await authorizeCommand(policy, loaded, definition, identity, resolved, ctx, requestSignal);
    throwIfRequestAborted(requestSignal);
    const outcome = await executeAuthorizedCommand(
      executor,
      resolved,
      loaded.projectPath,
      requestSignal,
    );
    const details = outputDetails(identity, loaded.projectPath, resolved, outcome);
    if (outcome.status === "cancelled" || requestSignal?.aborted) {
      throw cancellationError(details);
    }
    if (outcome.status !== "success" && !hasAcceptedExitCode(resolved, outcome)) {
      throw createExecutionFailure(identity, loaded.projectPath, resolved, outcome);
    }
    return result(details);
  };
}
