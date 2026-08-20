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
  isProjectCommandResolutionError,
  resolveProjectCommand,
  type ProjectCommandResolutionError,
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
  readonly resolvedCommand: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly projectInfo?: unknown;
  readonly nodeVersion?: string;
  readonly manifestPresent?: boolean;
  readonly packageManager?: unknown;
  readonly scripts?: readonly string[];
  readonly applicableCommands?: readonly string[];
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

function displayCommand(resolved: ResolvedProjectCommand): string {
  return resolved.displayCommand ?? [resolved.executable, ...resolved.args].join(" ");
}

function outputDetails(
  identity: CommandIdentity,
  projectPath: string,
  resolved: ResolvedProjectCommand,
  outcome: ProjectCommandExecutionOutcome,
): ProjectCommandOutputDetails {
  const projectInfo =
    typeof outcome.structuredDetails === "object" && outcome.structuredDetails !== null
      ? (outcome.structuredDetails as {
          readonly nodeVersion?: string;
          readonly manifestPresent?: boolean;
          readonly packageManager?: unknown;
          readonly scripts?: readonly string[];
          readonly applicableCommands?: readonly string[];
        })
      : undefined;
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
    resolvedCommand: displayCommand(resolved),
    parameters: resolved.effectiveParameters ?? Object.freeze({}),
    ...(outcome.structuredDetails === undefined
      ? {}
      : {
          projectInfo: outcome.structuredDetails,
          ...(projectInfo?.nodeVersion === undefined
            ? {}
            : {
                nodeVersion: projectInfo.nodeVersion,
                manifestPresent: projectInfo.manifestPresent,
                packageManager: projectInfo.packageManager,
                scripts: projectInfo.scripts,
                applicableCommands: projectInfo.applicableCommands,
              }),
        }),
  };
}

function serializeDiagnostic(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

function outputDiagnostic(
  label: "stdout" | "stderr",
  output: ProjectCommandExecutionOutcome["stdout"],
): string | undefined {
  if (output.text.length === 0) {
    return undefined;
  }
  const truncation = output.truncated
    ? ` (truncated; ${output.totalBytes.toString(10)} bytes total)`
    : "";
  return `${label}: ${serializeDiagnostic(output.text)}${truncation}`;
}

function executionFailureReason(status: ProjectCommandExecutionOutcome["status"]): string {
  switch (status) {
    case "nonzero":
      return "the command exited with a nonzero status";
    case "timeout":
      return "the command timed out";
    case "spawn-failure":
      return "the command could not be started";
    case "cancelled":
      return "the command was cancelled";
    case "success":
      return "the command completed successfully";
  }
  return "the command failed";
}

function executionFailureMessage(details: ProjectCommandOutputDetails): string {
  const exit = [
    details.exit.code === null ? undefined : `code ${details.exit.code.toString(10)}`,
    details.exit.signal === null ? undefined : `signal ${details.exit.signal}`,
  ].filter((part): part is string => part !== undefined);
  const diagnostic =
    outputDiagnostic("stderr", details.stderr) ?? outputDiagnostic("stdout", details.stdout);
  return [
    "Project command failed",
    `status: ${details.status}`,
    `reason: ${executionFailureReason(details.status)}`,
    `commandId: ${details.commandId}`,
    `resolvedCommand: ${details.resolvedCommand}`,
    `parameters: ${serializeDiagnostic(details.parameters)}`,
    `exit: ${exit.length === 0 ? "unavailable" : exit.join(", ")}`,
    diagnostic,
  ]
    .filter((part): part is string => part !== undefined)
    .join("; ");
}

function failure(
  identity: CommandIdentity,
  projectPath: string,
  resolved: ResolvedProjectCommand,
  outcome: ProjectCommandExecutionOutcome,
): ProjectCommandToolError {
  const details = outputDetails(identity, projectPath, resolved, outcome);
  return new ProjectCommandToolError(executionFailureMessage(details), details);
}

type ProjectCommandRequestParameters = Readonly<Record<string, unknown>> & {
  readonly commandId: string;
};

function resolutionFailure(
  params: ProjectCommandRequestParameters,
  error: ProjectCommandResolutionError,
): ProjectCommandToolError {
  const details = Object.freeze({
    ...error.details,
    status: "resolution-failure" as const,
    executed: false as const,
    commandId: params.commandId,
    requestedParameters: params,
    parameters: params,
    stage: error.stage,
    code: error.code,
    resolution: error.details,
    resolutionDetails: error.details,
  });
  const message = [
    "Project command resolution failed",
    "status: resolution-failure",
    `commandId: ${params.commandId}`,
    `requested parameters: ${serializeDiagnostic(params)}`,
    `stage: ${error.stage}`,
    `code: ${error.code}`,
    "execution: not attempted",
    `details: ${serializeDiagnostic(error.details)}`,
  ].join("; ");
  return new ProjectCommandToolError(message, details);
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
      throw resolutionFailure(params, error);
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
      "Run one fixed Node dependency listing or package script, six fixed Fallow analyses, or the existing workspace_path, node_version, and node_project_info observations. node_project_info reports project state in process; node_deps_list uses a detected package manager's fixed read-only list form; node_test, node_build, node_lint, node_lint_fix, node_typecheck, node_format_check, and node_format_write run only exact package.json scripts, with node_lint_fix and node_format_write changing project files. Fallow commands run only the project-local Fallow binary with fixed machine-readable arguments. Do not use this tool for dependency installation, Git inspection, file access, arbitrary commands, environment inspection, or project mutation outside node_lint_fix and node_format_write.",
    promptSnippet:
      "Inspect Node project state, list top-level dependencies, run one exact Node package script including lint fixes and formatting, or run one fixed Fallow analysis",
    promptGuidelines: [
      "Use project_command with commandId workspace_path when you need the current project workspace path.",
      "Use project_command with commandId node_version when you need the active Node.js runtime version.",
      "Use project_command with commandId node_project_info before selecting an applicable Node command.",
      "Use node_deps_list to inspect top-level dependencies when node_project_info reports it as applicable.",
      "Use node_test with optional workspace-relative paths only when package.json has an exact test script.",
      "Use node_build, node_lint, or node_typecheck only when package.json has the exact corresponding script.",
      "Use node_lint_fix only when package.json has the exact lint:fix script and you intend to modify project files.",
      "Use node_format_check only when package.json has the exact format:check script.",
      "Use node_format_write only when package.json has the exact format script and you intend to modify project files.",
      "Use fallow_dead_code, fallow_dupes, fallow_health, fallow_audit, fallow_list_entry_points, or fallow_list_boundaries only with their fixed machine-readable Fallow forms.",
      "Do not use project_command for dependency installation, Git inspection, file inspection, arbitrary commands, environment access, or project mutation outside node_lint_fix and node_format_write.",
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
        throw failure(identity, loaded.projectPath, resolved, outcome);
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
