import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { authorizeOrPrompt, type AuthorizationErrorKind } from "../authorization.ts";
import { displayPath } from "../path-display.ts";
import { findProjectCommandPolicyDecision } from "../policy/decisions.ts";
import { createPolicyStore, createPolicyStoreForTesting } from "../policy/store.ts";
import type { CommandIdentity, PolicyStore, PolicyStoreTestOptions } from "../policy/types.ts";
import {
  getProjectCommandDefinitions,
  projectCommandIdentity,
  type BuiltInProjectCommandDefinitions,
  type ProjectCommandDefinition,
} from "./definitions.ts";
import { createProjectCommandExecutor, type ProjectCommandExecutionOutcome } from "./execution.ts";
import {
  resolveProjectCommand,
  type ProjectCommandResolver,
  type ResolvedProjectCommand,
} from "./resolution.ts";
import {
  cancellationError,
  createProjectCommandInputSchema,
  ProjectCommandToolError,
  type ProjectCommandInputFor,
  type ProjectCommandInputSchema,
  validateProjectCommandInput,
} from "./schema.ts";

export interface ProjectCommandOutputDetails {
  readonly commandId: string;
  readonly projectPath: string;
  readonly fingerprint: string;
  readonly status: ProjectCommandExecutionOutcome["status"];
  readonly exit: ProjectCommandExecutionOutcome["exit"];
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly stdout: ProjectCommandExecutionOutcome["stdout"];
  readonly stderr: ProjectCommandExecutionOutcome["stderr"];
}

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

export interface ProjectCommandToolTestOptions<
  Definitions extends readonly ProjectCommandDefinition[] = readonly ProjectCommandDefinition[],
> {
  readonly configPath?: string;
  readonly fs?: Partial<import("../policy/filesystem.ts").PolicyFileSystem>;
  readonly policy?: PolicyStore;
  readonly executor?: ProjectCommandExecutor;
  readonly resolver?: ProjectCommandResolver;
  readonly definitions?: Definitions;
}

export type ProjectCommandToolDefinition<
  Definitions extends readonly ProjectCommandDefinition[] = BuiltInProjectCommandDefinitions,
> = Omit<
  ToolDefinition<ProjectCommandInputSchema<Definitions>, ProjectCommandOutputDetails>,
  "execute"
> & { execute: ProjectCommandExecute<Definitions> };

type ProjectCommandExecute<Definitions extends readonly ProjectCommandDefinition[]> = (
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

function outputDetails(
  identity: CommandIdentity,
  projectPath: string,
  outcome: ProjectCommandExecutionOutcome,
): ProjectCommandOutputDetails {
  return {
    commandId: identity.commandId,
    projectPath: displayPath(projectPath),
    fingerprint: identity.fingerprint,
    status: outcome.status,
    exit: outcome.exit,
    timedOut: outcome.timedOut,
    cancelled: outcome.cancelled,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
  };
}

function failure(
  message: string,
  identity: CommandIdentity,
  projectPath: string,
  outcome: ProjectCommandExecutionOutcome,
): ProjectCommandToolError {
  return new ProjectCommandToolError(message, outputDetails(identity, projectPath, outcome));
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
    promptText: (currentIdentity) => `Authorize project command ${currentIdentity.commandId}`,
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

function failureMessage(
  status: Exclude<ProjectCommandExecutionOutcome["status"], "success" | "cancelled">,
): string {
  switch (status) {
    case "nonzero":
      return "Project command exited unsuccessfully";
    case "timeout":
      return "Project command timed out";
    case "spawn-failure":
      return "Project command could not be started";
    default:
      return "Project command failed";
  }
}

function captureDefinitions<const Definitions extends readonly ProjectCommandDefinition[]>(
  definitions: Definitions,
): Definitions;
function captureDefinitions(
  definitions: readonly ProjectCommandDefinition[],
): readonly ProjectCommandDefinition[];
function captureDefinitions(
  definitions: readonly ProjectCommandDefinition[],
): readonly ProjectCommandDefinition[] {
  const captured: ProjectCommandDefinition[] = [];
  const seenIds = new Set<string>();
  for (const definition of definitions) {
    if (seenIds.has(definition.commandId)) {
      throw new ProjectCommandToolError(
        "Project command definitions contain duplicate command IDs",
      );
    }
    seenIds.add(definition.commandId);
    captured.push(Object.freeze({ ...definition, args: Object.freeze([...definition.args]) }));
  }
  return Object.freeze(captured);
}

function createToolWithDependencies<const Definitions extends readonly ProjectCommandDefinition[]>(
  policy: PolicyStore,
  executor: ProjectCommandExecutor,
  resolver: ProjectCommandResolver,
  definitions: Definitions,
): ProjectCommandToolDefinition<Definitions> {
  const capturedDefinitions = captureDefinitions(definitions);
  const byId = new Map<string, ProjectCommandDefinition>();
  for (const definition of capturedDefinitions) {
    byId.set(definition.commandId, definition);
  }
  const parameters = createProjectCommandInputSchema(capturedDefinitions);
  return {
    name: "project_command",
    label: "Project command",
    description:
      "Run one of two fixed, user-authorized project commands: workspace_path reports the canonical project directory, and node_version reports the active Node.js runtime version. Do not use this tool for arbitrary shell commands, file access, Git inspection, environment inspection, package scripts, or project mutation.",
    promptSnippet:
      "Get the project path or Node.js version through a fixed, user-authorized command",
    promptGuidelines: [
      "Use project_command with commandId workspace_path when you need the current project workspace path.",
      "Use project_command with commandId node_version when you need the active Node.js runtime version.",
      "Do not use project_command for Git inspection; use git_status, git_diff, git_log, or git_show instead.",
      "Do not use project_command for file or directory inspection; use read, grep, find, or ls instead.",
      "Do not use project_command for arbitrary commands, package scripts, environment access, or project mutation.",
    ],
    parameters,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = validateProjectCommandInput(rawParams, capturedDefinitions);
      const definition = byId.get(params.commandId);
      if (definition === undefined) {
        throw new ProjectCommandToolError("Project command request is invalid");
      }
      const requestSignal = signal ?? ctx.signal;
      const loaded = await loadPolicy(policy, ctx.cwd, requestSignal);
      const resolved = await resolver(definition, loaded.projectPath, requestSignal);
      throwIfRequestAborted(requestSignal);
      const identity = projectCommandIdentity(definition, resolved);
      await authorizeCommand(policy, loaded, definition, identity, ctx, requestSignal);
      throwIfRequestAborted(requestSignal);
      const outcome = await executeAuthorizedCommand(
        executor,
        resolved,
        loaded.projectPath,
        requestSignal,
      );
      const details = outputDetails(identity, loaded.projectPath, outcome);
      if (outcome.status === "cancelled" || requestSignal?.aborted) {
        throw cancellationError(details);
      }
      if (outcome.status !== "success") {
        throw failure(failureMessage(outcome.status), identity, loaded.projectPath, outcome);
      }
      return result(details);
    },
  };
}

export function createProjectCommandTool(): ProjectCommandToolDefinition {
  return createToolWithDependencies(
    createPolicyStore(),
    createProjectCommandExecutor(),
    resolveProjectCommand,
    getProjectCommandDefinitions(),
  );
}

export function createProjectCommandToolForTesting<
  const Definitions extends readonly ProjectCommandDefinition[] = BuiltInProjectCommandDefinitions,
>(
  options: ProjectCommandToolTestOptions<Definitions> & { readonly policy: PolicyStore },
): ProjectCommandToolDefinition<Definitions>;
export function createProjectCommandToolForTesting<
  const Definitions extends readonly ProjectCommandDefinition[] = BuiltInProjectCommandDefinitions,
>(
  options: ProjectCommandToolTestOptions<Definitions> & { readonly configPath: string },
): ProjectCommandToolDefinition<Definitions>;
export function createProjectCommandToolForTesting<
  const Definitions extends readonly ProjectCommandDefinition[] = BuiltInProjectCommandDefinitions,
>(
  options: ProjectCommandToolTestOptions<Definitions>,
): ProjectCommandToolDefinition<Definitions | BuiltInProjectCommandDefinitions> {
  let policy = options.policy;
  if (policy === undefined) {
    if (options.configPath === undefined) {
      throw new ProjectCommandToolError("A policy or config path is required for testing");
    }
    policy = createPolicyStoreForTesting({
      configPath: options.configPath,
      fs: options.fs,
    } satisfies PolicyStoreTestOptions);
  }
  const definitions = options.definitions ?? getProjectCommandDefinitions();
  return createToolWithDependencies(
    policy,
    options.executor ?? createProjectCommandExecutor(),
    options.resolver ?? resolveProjectCommand,
    definitions,
  );
}
