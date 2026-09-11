import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { AuthorizationOutcomeRecorder } from "../../observability/authorization-outcome.ts";
import { hashToolParameters } from "../../observability/canonical-json.ts";
import type { ProjectCommandInvocationRecorder } from "../../observability/project-command-invocation.ts";
import type { AuthorizationRetryTracker } from "../authorization-retry.ts";
import { renderCallLine, renderStringArgument, truncateRenderText } from "../call-render.ts";
import { createPolicyStore, createPolicyStoreForTesting } from "../policy/store.ts";
import type { PolicyStore, PolicyStoreTestOptions } from "../policy/types.ts";
import type { ProjectCommandResultCache } from "./cache.ts";
import {
  getProjectCommandDefinitions,
  type BuiltInProjectCommandDefinitions,
  type ProjectCommandDefinition,
} from "./definitions.ts";
import { createProjectCommandEvidenceStore, type ProjectCommandEvidenceStore } from "./evidence.ts";
import { createProjectCommandExecutor } from "./execution.ts";
import type { ProjectCommandOutputDetails } from "./output.ts";
import type { ProjectCommandRelevantInputDiscovery } from "./relevant-inputs.ts";
import type { ProjectCommandRepositoryStateReader } from "./repository-state.ts";
import { resolveProjectCommand, type ProjectCommandResolver } from "./resolution.ts";
import {
  createProjectCommandExecute,
  type ProjectCommandExecute,
  type ProjectCommandExecutor,
} from "./runner.ts";
import {
  createProjectCommandInputSchema,
  ProjectCommandToolError,
  type ProjectCommandInputSchema,
} from "./schema.ts";
import type { ProjectCommandStateSnapshotter } from "./state-snapshot.ts";

const PROJECT_COMMAND_DESCRIPTION =
  "Run one fixed Node dependency listing or package script, six fixed Fallow analyses, or the existing workspace_path, node_version, and node_project_info observations. node_project_info reports project state in process; node_deps_list uses a detected package manager's fixed read-only list form; supported Node script commands run only exact package.json scripts or validated existing lint:<variant>, test:<variant>, and format:<variant> family forms. Variants use bounded package-script-safe names and select the exact script configured by the project. Fallow commands run only the project-local Fallow binary with fixed machine-readable arguments. Executing evidence requests may include opaque covers and publish: { flowId }; lookup-only requests accept only ref, optional flowId, and covers and never execute a command. Evidence refs are non-replayable and process-scoped unless explicitly published to an authorized flow. Do not use this tool for dependency installation, Git inspection, file access, arbitrary commands, environment inspection, or project mutation outside the project-controlled package scripts exposed by this catalog.";

const PROJECT_COMMAND_PROMPT_GUIDELINES = [
  "Use project_command with commandId workspace_path when you need the current project workspace path.",
  "Use project_command with commandId node_version when you need the active Node.js runtime version.",
  "Use project_command with commandId node_project_info before selecting an applicable Node command.",
  "Use node_deps_list to inspect top-level dependencies when node_project_info reports it as applicable.",
  "Use node_test with optional workspace-relative paths only when package.json has the exact test script; its optional variant selects an existing validated test:<variant> script, including project-defined coverage or E2E scripts.",
  "Use node_build or node_typecheck only when package.json has the exact corresponding script; node_lint accepts an optional variant selecting an existing validated lint:<variant> script, including project-defined fix scripts.",
  "Use node_format with an optional variant only when package.json has the exact format or format:<variant> script; formatting scripts may modify project files.",
  "Use fallow_dead_code, fallow_dupes, fallow_health, fallow_audit, fallow_list_entry_points, or fallow_list_boundaries only with their fixed machine-readable Fallow forms.",
  "Use project_command with ref and optional flowId only to look up stored non-replayable evidence; lookup parameters cannot be combined with publish or other execution options.",
  "Executing project_command requests may include covers and publish: { flowId } to preserve or explicitly publish evidence.",
  "Do not use project_command for dependency installation, Git inspection, file inspection, arbitrary commands, environment access, or project mutation outside the project-controlled package scripts exposed by this catalog.",
] as const;

export type { ProjectCommandOutputDetails } from "./output.ts";
export type { ProjectCommandExecutor, ProjectCommandToolContext } from "./runner.ts";

export interface ProjectCommandToolTestOptions<
  Definitions extends readonly ProjectCommandDefinition[] = readonly ProjectCommandDefinition[],
> {
  readonly configPath?: string;
  readonly fs?: Partial<import("../policy/filesystem.ts").PolicyFileSystem>;
  readonly policy?: PolicyStore;
  readonly executor?: ProjectCommandExecutor;
  readonly resolver?: ProjectCommandResolver;
  readonly relevantInputDiscovery?: ProjectCommandRelevantInputDiscovery;
  readonly stateSnapshotter?: ProjectCommandStateSnapshotter;
  readonly repositoryStateReader?: ProjectCommandRepositoryStateReader;
  readonly cache?: ProjectCommandResultCache;
  readonly evidence?: ProjectCommandEvidenceStore;
  readonly definitions?: Definitions;
  readonly invocationRecorder?: ProjectCommandInvocationRecorder;
  readonly schemaHash?: string;
}

export interface ProjectCommandToolOptions {
  readonly invocationRecorder?: ProjectCommandInvocationRecorder;
  readonly schemaHash?: string;
  readonly repositoryStateReader?: ProjectCommandRepositoryStateReader;
  readonly cache?: ProjectCommandResultCache;
  readonly evidence?: ProjectCommandEvidenceStore;
  readonly authorizationOutcomeRecorder?: AuthorizationOutcomeRecorder;
  readonly authorizationRetryTracker?: AuthorizationRetryTracker;
}

export type ProjectCommandToolDefinition<
  Definitions extends readonly ProjectCommandDefinition[] = BuiltInProjectCommandDefinitions,
> = Omit<
  ToolDefinition<ProjectCommandInputSchema<Definitions>, ProjectCommandOutputDetails>,
  "execute"
> & { execute: ProjectCommandExecute<Definitions> };

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
  relevantInputDiscovery?: ProjectCommandRelevantInputDiscovery,
  stateSnapshotter?: ProjectCommandStateSnapshotter,
  cache?: ProjectCommandResultCache,
  evidence: ProjectCommandEvidenceStore = createProjectCommandEvidenceStore(),
  invocationOptions: ProjectCommandToolOptions = {},
): ProjectCommandToolDefinition<Definitions> {
  const capturedDefinitions = captureDefinitions(definitions);
  const byId = new Map<string, ProjectCommandDefinition>();
  for (const definition of capturedDefinitions) {
    byId.set(definition.commandId, definition);
  }
  const parameters = createProjectCommandInputSchema(capturedDefinitions);
  const schemaHash = invocationOptions.schemaHash ?? hashToolParameters(parameters);
  return {
    name: "project_command",
    label: "Project command",
    description: PROJECT_COMMAND_DESCRIPTION,
    promptSnippet:
      "Inspect Node project state, list top-level dependencies, run one exact Node package script or validated variant including lint fixes and formatting, or run one fixed Fallow analysis",
    promptGuidelines: [...PROJECT_COMMAND_PROMPT_GUIDELINES],
    parameters,
    executionMode: "sequential",
    renderCall(args, theme) {
      const options: Record<string, unknown> = Object.assign({}, args);
      const parts: string[] = [renderStringArgument(options.commandId, theme)];
      delete options.commandId;
      if (Object.keys(options).length > 0) {
        parts.push(theme.fg("muted", truncateRenderText(JSON.stringify(options))));
      }
      return renderCallLine(theme, "project_command", parts);
    },
    execute: createProjectCommandExecute(
      policy,
      executor,
      resolver,
      capturedDefinitions,
      byId,
      relevantInputDiscovery,
      stateSnapshotter,
      cache,
      {
        recorder: invocationOptions.invocationRecorder,
        schemaHash,
        repositoryStateReader: invocationOptions.repositoryStateReader,
        evidence,
        authorizationOutcomeRecorder: invocationOptions.authorizationOutcomeRecorder,
        authorizationRetryTracker: invocationOptions.authorizationRetryTracker,
      },
    ),
  };
}

export function createProjectCommandTool(
  options: ProjectCommandToolOptions = {},
): ProjectCommandToolDefinition {
  return createToolWithDependencies(
    createPolicyStore(),
    createProjectCommandExecutor(),
    resolveProjectCommand,
    getProjectCommandDefinitions(),
    undefined,
    undefined,
    options.cache,
    options.evidence,
    options,
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
    options.relevantInputDiscovery,
    options.stateSnapshotter,
    options.cache,
    options.evidence,
    {
      invocationRecorder: options.invocationRecorder,
      schemaHash: options.schemaHash,
      repositoryStateReader: options.repositoryStateReader,
    },
  );
}
