import { performance } from "node:perf_hooks";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createToolErrorContract,
  withToolErrorContract,
  type ToolErrorContract,
} from "../errors.ts";
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
  suggestedActionForCategory,
  type ProjectCommandInvocationMetadata,
  type ProjectCommandOutputDetails,
  type ProjectCommandRequestParameters,
} from "./output.ts";
import { ProjectCommandResolutionError, isProjectCommandResolutionError } from "./resolution.ts";
import type { ProjectCommandResolver, ResolvedProjectCommand } from "./resolution/types.ts";
import {
  cancellationError,
  invalidRequest,
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

function elapsedMilliseconds(start: number, end: number): number {
  const elapsed = end - start;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
}

function invocationMetadata(
  toolCallId: string,
  startedAt: number,
  executionStartedAt: number | undefined,
  finishedAt: number,
): ProjectCommandInvocationMetadata {
  const executionDurationMs =
    executionStartedAt === undefined ? 0 : elapsedMilliseconds(executionStartedAt, finishedAt);
  const durationMs = Math.max(elapsedMilliseconds(startedAt, finishedAt), executionDurationMs);
  return { toolCallId, durationMs, executionDurationMs, reused: false };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function enrichToolError(
  error: ProjectCommandToolError,
  metadata: ProjectCommandInvocationMetadata,
): ProjectCommandToolError {
  const details = isRecord(error.details)
    ? { ...error.details, ...metadata }
    : { ...metadata, detail: error.details };
  const enriched = new ProjectCommandToolError(error.message, details, error.contract);
  enriched.name = error.name;
  return enriched;
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
    if (error instanceof ProjectCommandToolError && error.name === "AbortError") {
      throw error;
    }
    if (signal?.aborted) {
      throw commandCancellationError();
    }
    if (isProjectCommandResolutionError(error)) {
      throw createResolutionFailure(params, error);
    }
    throw createResolutionFailure(
      params,
      new ProjectCommandResolutionError("probe", "resolution-failure"),
    );
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
  "denied-once": "Project command denied for this request",
  "not-authorized": "Project command is not authorized in this mode",
  timeout: "Project command confirmation timed out",
  confirmation: "Project command confirmation failed",
  save: "Unable to save project command policy",
  "unsafe-global": "Project command cannot be allowed globally",
  "invalid-choice": "Project command confirmation returned an invalid choice",
  load: "Unable to load project command policy",
};

function authorizationContract(
  kind: Exclude<AuthorizationErrorKind, "cancelled" | "dismissed">,
): ToolErrorContract {
  const blocked =
    kind === "denied" ||
    kind === "denied-once" ||
    kind === "not-authorized" ||
    kind === "unsafe-global";
  const timeout = kind === "timeout";
  return createToolErrorContract({
    code: timeout ? "confirmation-timeout" : `policy-${kind}`,
    category: blocked ? "BLOCKED" : timeout ? "TIMEOUT" : "POLICY_FAILURE",
    explanation: PROJECT_COMMAND_AUTHORIZATION_MESSAGES[kind],
    suggestedAction: suggestedActionForCategory(
      blocked ? "BLOCKED" : timeout ? "TIMEOUT" : "POLICY_FAILURE",
    ),
    retryable: timeout || !blocked,
    executed: false,
  });
}

function authorizationError(kind: AuthorizationErrorKind): ProjectCommandToolError {
  if (kind === "cancelled" || kind === "dismissed") {
    return commandCancellationError();
  }
  const message = PROJECT_COMMAND_AUTHORIZATION_MESSAGES[kind];
  const contract = authorizationContract(kind);
  return new ProjectCommandToolError(message, withToolErrorContract({}, contract), contract);
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
    const contract = createToolErrorContract({
      code: "policy-load-failure",
      category: "POLICY_FAILURE",
      explanation: "The project command policy could not be loaded.",
      suggestedAction: suggestedActionForCategory("POLICY_FAILURE"),
      retryable: true,
      executed: false,
    });
    throw new ProjectCommandToolError(
      "Unable to load project command policy",
      withToolErrorContract({}, contract),
      contract,
    );
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
    allowGlobal: false,
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

function cancellationOutcome(): ProjectCommandExecutionOutcome {
  return {
    status: "cancelled",
    exit: { code: null, signal: null },
    timedOut: false,
    cancelled: true,
    executed: true,
    stdout: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
    stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
  };
}

function cancellationOutputDetails(
  details: ProjectCommandOutputDetails,
): ProjectCommandOutputDetails {
  return {
    ...details,
    status: "cancelled",
    category: "CANCELLED",
    executed: true,
    exit: { code: null, signal: null },
    timedOut: false,
    cancelled: true,
    suggestedAction: suggestedActionForCategory("CANCELLED"),
  };
}

function executorFailure(): ProjectCommandToolError {
  const contract = createToolErrorContract({
    code: "executor-failure",
    category: "IMPLEMENTATION_FAILURE",
    explanation: "The project command executor failed.",
    suggestedAction: suggestedActionForCategory("IMPLEMENTATION_FAILURE"),
    retryable: false,
    executed: true,
  });
  return new ProjectCommandToolError(
    "Project command executor failed",
    withToolErrorContract({}, contract),
    contract,
  );
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
    if (signal?.aborted) {
      return cancellationOutcome();
    }
    throw executorFailure();
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
  return async (toolCallId, rawParams, signal, _onUpdate, ctx) => {
    const startedAt = performance.now();
    let executionStartedAt: number | undefined;
    try {
      const params = validateProjectCommandInput(
        rawParams,
        capturedDefinitions,
      ) as ProjectCommandInputFor<Definitions>;
      const definition = byId.get(params.commandId);
      if (definition === undefined) {
        throw invalidRequest("commandId");
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
      executionStartedAt = performance.now();
      const outcome = await executeAuthorizedCommand(
        executor,
        resolved,
        loaded.projectPath,
        requestSignal,
      );
      const metadata = invocationMetadata(
        toolCallId,
        startedAt,
        executionStartedAt,
        performance.now(),
      );
      const details = outputDetails(identity, loaded.projectPath, resolved, outcome, metadata);
      if (outcome.status === "cancelled" || requestSignal?.aborted) {
        throw cancellationError(cancellationOutputDetails(details));
      }
      if (outcome.status !== "success" && !hasAcceptedExitCode(resolved, outcome)) {
        throw createExecutionFailure(identity, loaded.projectPath, resolved, outcome, metadata);
      }
      return result(details);
    } catch (error) {
      if (error instanceof ProjectCommandToolError) {
        throw enrichToolError(
          error,
          invocationMetadata(toolCallId, startedAt, executionStartedAt, performance.now()),
        );
      }
      throw error;
    }
  };
}
