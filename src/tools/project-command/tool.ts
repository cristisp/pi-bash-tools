import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createPolicyStore, createPolicyStoreForTesting } from "../policy/store.ts";
import type { PolicyStore, PolicyStoreTestOptions } from "../policy/types.ts";
import {
  getProjectCommandDefinitions,
  type BuiltInProjectCommandDefinitions,
  type ProjectCommandDefinition,
} from "./definitions.ts";
import { createProjectCommandExecutor } from "./execution.ts";
import { resolveProjectCommand, type ProjectCommandResolver } from "./resolution.ts";
import {
  createProjectCommandInputSchema,
  ProjectCommandToolError,
  type ProjectCommandInputSchema,
} from "./schema.ts";
import type { ProjectCommandOutputDetails } from "./output.ts";
import {
  createProjectCommandExecute,
  type ProjectCommandExecute,
  type ProjectCommandExecutor,
} from "./runner.ts";

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
  readonly definitions?: Definitions;
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
): ProjectCommandToolDefinition<Definitions> {
  const capturedDefinitions = captureDefinitions(definitions);
  const byId = new Map<string, ProjectCommandDefinition>();
  for (const definition of capturedDefinitions) {
    byId.set(definition.commandId, definition);
  }
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
    parameters: createProjectCommandInputSchema(capturedDefinitions),
    executionMode: "sequential",
    execute: createProjectCommandExecute(policy, executor, resolver, capturedDefinitions, byId),
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
