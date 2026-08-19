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
  type ProjectCommandDefinition,
} from "./definitions.ts";
import { createProjectCommandExecutor, type ProjectCommandExecutionOutcome } from "./execution.ts";
import {
  cancellationError,
  ProjectCommandToolError,
  projectCommandInputSchema,
  type ProjectCommandInput,
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
  definition: ProjectCommandDefinition,
  cwd: string,
  signal: AbortSignal | undefined,
) => Promise<ProjectCommandExecutionOutcome>;

export interface ProjectCommandToolTestOptions {
  readonly configPath?: string;
  readonly fs?: Partial<import("../policy/filesystem.ts").PolicyFileSystem>;
  readonly policy?: PolicyStore;
  readonly executor?: ProjectCommandExecutor;
  readonly definitions?: readonly ProjectCommandDefinition[];
}

export type ProjectCommandToolDefinition = Omit<
  ToolDefinition<typeof projectCommandInputSchema, ProjectCommandOutputDetails>,
  "execute"
> & { execute: ProjectCommandExecute };

type ProjectCommandExecute = (
  toolCallId: string,
  params: ProjectCommandInput,
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
  definition: ProjectCommandDefinition,
  projectPath: string,
  signal: AbortSignal | undefined,
): Promise<ProjectCommandExecutionOutcome> {
  try {
    return await executor(definition, projectPath, signal);
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

function createToolWithDependencies(
  policy: PolicyStore,
  executor: ProjectCommandExecutor,
  definitions: readonly ProjectCommandDefinition[],
): ProjectCommandToolDefinition {
  const byId = new Map(definitions.map((definition) => [definition.commandId, definition]));
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
    parameters: projectCommandInputSchema,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = validateProjectCommandInput(rawParams);
      const definition = byId.get(params.commandId);
      if (definition === undefined) {
        throw new ProjectCommandToolError("Project command request is invalid");
      }
      const requestSignal = signal ?? ctx.signal;
      const loaded = await loadPolicy(policy, ctx.cwd, requestSignal);
      const identity = projectCommandIdentity(definition);
      await authorizeCommand(policy, loaded, definition, identity, ctx, requestSignal);
      throwIfRequestAborted(requestSignal);
      const outcome = await executeAuthorizedCommand(
        executor,
        definition,
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
    getProjectCommandDefinitions(),
  );
}

export function createProjectCommandToolForTesting(
  options: ProjectCommandToolTestOptions & { readonly policy: PolicyStore },
): ProjectCommandToolDefinition;
export function createProjectCommandToolForTesting(
  options: ProjectCommandToolTestOptions & { readonly configPath: string },
): ProjectCommandToolDefinition;
export function createProjectCommandToolForTesting(
  options: ProjectCommandToolTestOptions,
): ProjectCommandToolDefinition {
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
  return createToolWithDependencies(
    policy,
    options.executor ?? createProjectCommandExecutor(),
    options.definitions ?? getProjectCommandDefinitions(),
  );
}
