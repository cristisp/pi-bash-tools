import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { hasControlCharacter } from "../parameters/text-validation.ts";
import {
  isProjectCommandWorkspaceSnapshotApproved,
  type ProjectCommandDefinition,
} from "../definitions.ts";
import {
  canonicalProjectCommandRelevantInputs,
  PROJECT_COMMAND_MAX_RELEVANT_INPUT_CONFIG_PATHS,
  PROJECT_COMMAND_MAX_RELEVANT_INPUT_PATH_LENGTH,
  type ProjectCommandRelevantInputCommandRequest,
  type ProjectCommandRelevantInputDiscovery,
  type ProjectCommandRelevantInputDiscoveryRequest,
  type ProjectCommandRelevantInputDiscoveryResult,
  type ProjectCommandRelevantInputFile,
  type ProjectCommandRelevantInputValue,
} from "../relevant-inputs.ts";
import { validateNodeE2EParameters, validateNodeTestPaths } from "../parameters.ts";
import { readNodeProjectState } from "./project-state/reader.ts";
import { hashNodeScriptInternal } from "./project-state/manifest.ts";
import type { NodeFileSystem } from "./types.ts";
import type { NodeProjectResolutionOptions } from "../node.ts";
import { isMissingFileError } from "./project-state/errors.ts";

const defaultNodeFileSystem: NodeFileSystem = {
  readFile: (path, encoding) => readFile(path, encoding),
  stat,
};

function incomplete(reason: string): ProjectCommandRelevantInputDiscoveryResult {
  return Object.freeze({ status: "incomplete" as const, reason });
}

function errorResult(error: unknown): ProjectCommandRelevantInputDiscoveryResult {
  return Object.freeze({ status: "error" as const, error });
}

function isNodeProjectCommand(definition: ProjectCommandDefinition): boolean {
  return (
    definition.commandId === "node_project_info" ||
    definition.applicability === "node-script" ||
    definition.applicability === "node-dependency-list"
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedTestPaths(
  definition: ProjectCommandDefinition,
  parameters: unknown,
): readonly string[] {
  if (definition.commandId === "node_test") {
    const paths = validateNodeTestPaths(isRecord(parameters) ? parameters.paths : parameters);
    return Object.freeze(paths.map((path) => path.split("\\").join("/")));
  }
  if (definition.commandId === "node_e2e") {
    const normalized = validateNodeE2EParameters(parameters);
    return Object.freeze(normalized.paths.map((path) => path.split("\\").join("/")));
  }
  return Object.freeze([]);
}

function isSafeConfigPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > PROJECT_COMMAND_MAX_RELEVANT_INPUT_PATH_LENGTH ||
    isAbsolute(value) ||
    value.includes("\\") ||
    hasControlCharacter(value) ||
    ["*", "?", "[", "]", "{", "}"].some((character) => value.includes(character))
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function configPaths(
  definition: ProjectCommandDefinition,
): { readonly paths: readonly string[] } | { readonly reason: string } {
  const configured = definition.relevantInputConfigPaths ?? [];
  if (!Array.isArray(configured)) {
    return { reason: "invalid-relevant-input-config-paths" };
  }
  if (configured.length > PROJECT_COMMAND_MAX_RELEVANT_INPUT_CONFIG_PATHS) {
    return { reason: "too-many-relevant-input-config-paths" };
  }
  if (configured.some((path) => !isSafeConfigPath(path))) {
    return { reason: "invalid-relevant-input-config-path" };
  }
  const paths = [...new Set(configured)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return { paths: Object.freeze(paths) };
}

async function existingConfigFiles(
  projectPath: string,
  paths: readonly string[],
  fileSystem: NodeFileSystem,
): Promise<readonly ProjectCommandRelevantInputFile[]> {
  const files = await Promise.all(
    paths.map(async (path) => {
      try {
        const stats = await fileSystem.stat(join(projectPath, path));
        if (!stats.isFile()) {
          throw new Error(`Relevant input is not a file: ${path}`);
        }
        return Object.freeze({ kind: "file" as const, path });
      } catch (error) {
        if (isMissingFileError(error)) {
          return Object.freeze({ kind: "file" as const, path });
        }
        throw error;
      }
    }),
  );
  return Object.freeze(
    files.filter((file): file is ProjectCommandRelevantInputFile => file !== undefined),
  );
}

function stateIncompleteReason(
  definition: ProjectCommandDefinition,
  state: Awaited<ReturnType<typeof readNodeProjectState>>,
): string | undefined {
  if (state.manifest === null && definition.commandId !== "node_project_info") {
    return "missing-package-manifest";
  }
  if (state.manifest !== null && definition.fixedScriptKey !== undefined) {
    return state.manifest.scripts[definition.fixedScriptKey] === undefined
      ? "missing-package-script"
      : undefined;
  }
  return undefined;
}

function stateFiles(
  state: Awaited<ReturnType<typeof readNodeProjectState>>,
  configFiles: readonly ProjectCommandRelevantInputFile[],
): ProjectCommandRelevantInputFile[] {
  return [
    Object.freeze({ kind: "file", path: "package.json" }),
    ...state.lockfiles.map((path) => Object.freeze({ kind: "file", path })),
    ...configFiles,
  ];
}

function stateValues(
  definition: ProjectCommandDefinition,
  state: Awaited<ReturnType<typeof readNodeProjectState>>,
  paths: readonly string[],
): ProjectCommandRelevantInputValue[] {
  const values: ProjectCommandRelevantInputValue[] = [];
  if (state.manifest !== null && definition.fixedScriptKey !== undefined) {
    const script = state.manifest.scripts[definition.fixedScriptKey];
    if (script !== undefined) {
      values.push(
        Object.freeze({
          kind: "value",
          name: `package-script-hash:${definition.fixedScriptKey}`,
          value: hashNodeScriptInternal(script),
        }),
      );
    }
  }
  if (paths.length > 0) {
    values.push(
      Object.freeze({
        kind: "value",
        name: "explicit-test-paths",
        value: JSON.stringify(paths),
      }),
    );
  }
  return values;
}

async function discoverNodeProjectCommandRelevantInputsInternal(
  request: ProjectCommandRelevantInputCommandRequest,
  options: NodeProjectRelevantInputDiscoveryOptions,
): Promise<ProjectCommandRelevantInputDiscoveryResult> {
  const configured = configPaths(request.definition);
  if ("reason" in configured) return incomplete(configured.reason);
  const fileSystem = options.fileSystem ?? defaultNodeFileSystem;
  let paths: readonly string[];
  try {
    paths = normalizedTestPaths(request.definition, request.parameters);
  } catch (error) {
    return errorResult(error);
  }
  try {
    const state = await readNodeProjectState(
      request.projectPath,
      {
        availability: options.availability,
        fileSystem,
        nodeExecutable: options.nodeExecutable,
        approvedPackageManagerDirectories: options.approvedPackageManagerDirectories,
      },
      { allowMissing: true, probeFallow: false },
    );
    const reason = stateIncompleteReason(request.definition, state);
    if (reason !== undefined) return incomplete(reason);
    const configFiles = await existingConfigFiles(
      request.projectPath,
      configured.paths,
      fileSystem,
    );
    return Object.freeze({
      status: "complete" as const,
      inputs: canonicalProjectCommandRelevantInputs(
        stateFiles(state, configFiles),
        stateValues(request.definition, state, paths),
      ),
    });
  } catch (error) {
    return errorResult(error);
  }
}

export interface NodeProjectRelevantInputDiscoveryOptions extends Pick<
  NodeProjectResolutionOptions,
  "availability" | "fileSystem" | "nodeExecutable" | "approvedPackageManagerDirectories"
> {}

export function createNodeProjectRelevantInputDiscovery(
  options: NodeProjectRelevantInputDiscoveryOptions = {},
): ProjectCommandRelevantInputDiscovery {
  return Object.freeze({
    discover: (request: ProjectCommandRelevantInputDiscoveryRequest) => {
      if (request.kind === "workspace-snapshot") {
        return Promise.resolve(
          isProjectCommandWorkspaceSnapshotApproved(request.definition)
            ? incomplete("workspace-snapshot-requires-snapshot-discoverer")
            : incomplete("workspace-snapshot-not-approved"),
        );
      }
      if (!isNodeProjectCommand(request.definition)) {
        return Promise.resolve(incomplete("unsupported-project-command"));
      }
      return discoverNodeProjectCommandRelevantInputsInternal(request, options);
    },
  });
}
