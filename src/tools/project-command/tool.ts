import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
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
import {
  decisionForProjectCommandChoice,
  projectCommandCanPrompt,
  promptForProjectCommand,
  type ProjectCommandPromptResult,
} from "./prompt.ts";
import {
  createProjectCommandPolicyStore,
  createProjectCommandPolicyStoreForTesting,
  type LoadedProjectCommandPolicy,
  type ProjectCommandPolicyStore,
} from "./policy.ts";
import { findProjectCommandPolicyDecision } from "./policy-decisions.ts";
import type { ProjectCommandIdentity } from "../environment/policy/document.ts";
import { displayPath } from "../path-display.ts";

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
  readonly fs?: Partial<import("../environment/policy/filesystem.ts").PolicyFileSystem>;
  readonly policy?: ProjectCommandPolicyStore;
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
  identity: ProjectCommandIdentity,
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
  identity: ProjectCommandIdentity,
  projectPath: string,
  outcome: ProjectCommandExecutionOutcome,
): ProjectCommandToolError {
  return new ProjectCommandToolError(message, outputDetails(identity, projectPath, outcome));
}

async function persistDecision(
  policy: ProjectCommandPolicyStore,
  loaded: LoadedProjectCommandPolicy,
  identity: ProjectCommandIdentity,
  decision: "deny-global" | "deny-project" | "allow-global" | "allow-project",
  signal: AbortSignal | undefined,
  globalSafe: boolean,
): Promise<void> {
  if (signal?.aborted) {
    throw cancellationError();
  }
  try {
    await policy.recordDecision(loaded.projectPath, identity, decision, signal, globalSafe);
  } catch {
    if (signal?.aborted) {
      throw cancellationError();
    }
    throw new ProjectCommandToolError("Unable to save project command policy");
  }
  if (signal?.aborted) {
    throw cancellationError();
  }
}

async function resolveSelectedPrompt(
  choice: string | undefined,
  policy: ProjectCommandPolicyStore,
  loaded: LoadedProjectCommandPolicy,
  definition: ProjectCommandDefinition,
  identity: ProjectCommandIdentity,
  signal: AbortSignal | undefined,
): Promise<"allow-global" | "allow-project"> {
  if (choice === undefined || signal?.aborted) {
    throw cancellationError();
  }
  const decision = decisionForProjectCommandChoice(choice);
  if (decision === "deny-global" || decision === "deny-project") {
    await persistDecision(policy, loaded, identity, decision, signal, definition.globalSafe);
    throw new ProjectCommandToolError("Project command denied by policy");
  }
  if (decision === "allow-global" && !definition.globalSafe) {
    throw new ProjectCommandToolError("Project command cannot be allowed globally");
  }
  return decision;
}

async function resolvePrompt(
  prompt: ProjectCommandPromptResult,
  policy: ProjectCommandPolicyStore,
  loaded: LoadedProjectCommandPolicy,
  definition: ProjectCommandDefinition,
  identity: ProjectCommandIdentity,
  signal: AbortSignal | undefined,
): Promise<"allow-global" | "allow-project"> {
  switch (prompt.kind) {
    case "timeout":
      await persistDecision(
        policy,
        loaded,
        identity,
        "deny-project",
        signal,
        definition.globalSafe,
      );
      throw new ProjectCommandToolError("Project command confirmation timed out");
    case "cancelled":
      throw cancellationError();
    case "error":
      throw new ProjectCommandToolError("Project command confirmation failed");
    case "selected":
      return resolveSelectedPrompt(prompt.choice, policy, loaded, definition, identity, signal);
    default:
      throw new ProjectCommandToolError("Project command confirmation failed");
  }
}

function rethrowProjectCommandCancellation(error: unknown, signal: AbortSignal | undefined): void {
  if (error instanceof ProjectCommandToolError && error.name === "AbortError") {
    throw error;
  }
  if (signal?.aborted) {
    throw cancellationError();
  }
}

async function loadProjectCommandPolicy(
  policy: ProjectCommandPolicyStore,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<LoadedProjectCommandPolicy> {
  if (signal?.aborted) {
    throw cancellationError();
  }
  try {
    const loaded = await policy.load(cwd);
    if (signal?.aborted) {
      throw cancellationError();
    }
    return loaded;
  } catch (error) {
    rethrowProjectCommandCancellation(error, signal);
    throw new ProjectCommandToolError("Unable to load project command policy");
  }
}

async function authorizeProjectCommand(
  policy: ProjectCommandPolicyStore,
  loaded: LoadedProjectCommandPolicy,
  definition: ProjectCommandDefinition,
  identity: ProjectCommandIdentity,
  ctx: ProjectCommandToolContext,
  signal: AbortSignal | undefined,
): Promise<void> {
  let authorization: ReturnType<typeof findProjectCommandPolicyDecision>;
  try {
    authorization = findProjectCommandPolicyDecision(
      {
        version: 1,
        global: loaded.global,
        projects: { [loaded.projectPath]: loaded.project },
      },
      loaded.projectPath,
      identity,
      definition.globalSafe,
    );
  } catch {
    throw new ProjectCommandToolError("Unable to load project command policy");
  }
  if (authorization === "deny-global" || authorization === "deny-project") {
    throw new ProjectCommandToolError("Project command denied by policy");
  }
  if (authorization !== "unknown") {
    return;
  }
  if (!projectCommandCanPrompt(ctx.mode, ctx.hasUI, signal)) {
    throw new ProjectCommandToolError("Project command is not authorized in this mode");
  }
  const prompt = await promptForProjectCommand(
    ctx,
    definition.commandId,
    loaded.confirmationTimeoutMs,
    signal,
  );
  const decision = await resolvePrompt(prompt, policy, loaded, definition, identity, signal);
  await persistDecision(policy, loaded, identity, decision, signal, definition.globalSafe);
}

function executionFailureOutcome(): ProjectCommandExecutionOutcome {
  return {
    status: "spawn-failure",
    exit: { code: null, signal: null },
    timedOut: false,
    cancelled: false,
    stdout: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
    stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
  };
}

async function executeAuthorizedProjectCommand(
  executor: ProjectCommandExecutor,
  definition: ProjectCommandDefinition,
  projectPath: string,
  signal: AbortSignal | undefined,
): Promise<ProjectCommandExecutionOutcome> {
  try {
    return await executor(definition, projectPath, signal);
  } catch {
    return executionFailureOutcome();
  }
}

function executionFailureMessage(
  status: Exclude<ProjectCommandExecutionOutcome["status"], "success" | "cancelled">,
): string {
  switch (status) {
    case "nonzero":
      return "Project command exited unsuccessfully";
    case "timeout":
      return "Project command timed out";
    case "spawn-failure":
      return "Project command could not be started";
    case "cleanup-failure":
      return "Project command cleanup was unsupported";
    default:
      return "Project command failed";
  }
}

function createProjectCommandToolWithDependencies(
  policy: ProjectCommandPolicyStore,
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
      const loaded = await loadProjectCommandPolicy(policy, ctx.cwd, requestSignal);
      const identity = projectCommandIdentity(definition);
      await authorizeProjectCommand(policy, loaded, definition, identity, ctx, requestSignal);
      if (requestSignal?.aborted) {
        throw cancellationError();
      }
      const outcome = await executeAuthorizedProjectCommand(
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
        throw failure(
          executionFailureMessage(outcome.status),
          identity,
          loaded.projectPath,
          outcome,
        );
      }
      return result(details);
    },
  };
}

export function createProjectCommandTool(): ProjectCommandToolDefinition {
  return createProjectCommandToolWithDependencies(
    createProjectCommandPolicyStore(),
    createProjectCommandExecutor(),
    getProjectCommandDefinitions(),
  );
}

export function createProjectCommandToolForTesting(
  options: ProjectCommandToolTestOptions & { readonly policy: ProjectCommandPolicyStore },
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
    policy = createProjectCommandPolicyStoreForTesting({
      configPath: options.configPath,
      fs: options.fs,
    });
  }
  return createProjectCommandToolWithDependencies(
    policy,
    options.executor ?? createProjectCommandExecutor(),
    options.definitions ?? getProjectCommandDefinitions(),
  );
}
