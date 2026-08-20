import type { ProjectCommandDefinition, ResolvedCommandLine } from "./definitions.ts";
import { ProjectCommandResolutionError } from "./errors.ts";
import { validateProjectCommandRevision } from "./parameters.ts";
import { resolveProjectBinary } from "./binary.ts";
import {
  detectPackageManagerDetailsInternal as detectPackageManagerDetailsImpl,
  detectProjectPackageManagerInternal as detectProjectPackageManagerImpl,
  findPackageManagerExecutableInternal as findPackageManagerExecutableImpl,
  type DetectedPackageManager,
  type PackageManager,
  type PackageManagerAvailability,
  type PackageManagerAvailabilityInput,
  type PackageManagerDetectionInput,
  type PackageManagerExecutableResolutionOptions,
  type ProjectPackageManagerDetectionOptions,
} from "./package-manager.ts";

export { ProjectCommandResolutionError, isProjectCommandResolutionError } from "./errors.ts";
export { resolveProjectBinary } from "./binary.ts";
export type { ProjectResolutionFileSystem } from "./binary.ts";
export { detectPackageManagerInternal as detectPackageManager } from "./package-manager.ts";

export type {
  DetectedPackageManager,
  PackageManager,
  PackageManagerAvailability,
  PackageManagerAvailabilityInput,
  PackageManagerDetectionInput,
  PackageManagerExecutableResolutionOptions,
  ProjectPackageManagerDetectionOptions,
};

export function detectPackageManagerDetails(
  input: PackageManagerDetectionInput,
  availability: PackageManagerAvailabilityInput,
): DetectedPackageManager {
  return detectPackageManagerDetailsImpl(input, availability);
}

export function detectProjectPackageManager(
  projectPath: string,
  options: ProjectPackageManagerDetectionOptions,
): Promise<PackageManager>;
export function detectProjectPackageManager(
  projectPath: string,
  availability: PackageManagerAvailabilityInput,
): Promise<PackageManager>;
export function detectProjectPackageManager(
  projectPath: string,
  options?: ProjectPackageManagerDetectionOptions | PackageManagerAvailabilityInput,
): Promise<PackageManager> {
  return detectProjectPackageManagerImpl(projectPath, options);
}

export function findPackageManagerExecutable(
  manager: PackageManager,
  options?: PackageManagerExecutableResolutionOptions,
): Promise<string | undefined> {
  return findPackageManagerExecutableImpl(manager, options);
}

export interface ResolvedProjectCommand extends ResolvedCommandLine {
  readonly definition: ProjectCommandDefinition;
  readonly displayCommand?: string;
  readonly effectiveParameters?: Readonly<Record<string, unknown>>;
  readonly script?: string;
  readonly structuredDetails?: unknown;
}

export function resolveFixedProjectCommand(
  definition: ProjectCommandDefinition,
): ResolvedProjectCommand {
  return Object.freeze({
    definition,
    executable: definition.executable,
    args: definition.args,
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveFallowParameters(
  definition: ProjectCommandDefinition,
  parameters: unknown,
): { readonly base?: string; readonly effective: Readonly<Record<string, unknown>> } {
  const isAudit = definition.commandId === "fallow_audit";
  if (
    parameters !== undefined &&
    (!isRecord(parameters) ||
      Object.keys(parameters).some(
        (key) => key !== "commandId" && (isAudit ? key !== "base" : true),
      ))
  ) {
    throw new ProjectCommandResolutionError("probe", "invalid-fallow-parameters");
  }
  if (!isAudit) {
    return { effective: Object.freeze({}) };
  }
  const base = validateProjectCommandRevision(
    parameters === undefined || !isRecord(parameters) ? undefined : parameters.base,
  );
  return { base, effective: Object.freeze({ base }) };
}

async function resolveFallowProjectCommand(
  definition: ProjectCommandDefinition,
  projectPath: string,
  parameters: unknown,
): Promise<ResolvedProjectCommand> {
  if (definition.binaryName !== "fallow") {
    throw new ProjectCommandResolutionError("probe", "invalid-project-binary-definition");
  }
  const fallowParameters = resolveFallowParameters(definition, parameters);
  const binary = await resolveProjectBinary(projectPath, definition.binaryName);
  const args = [
    ...definition.args,
    ...(fallowParameters.base === undefined ? [] : ["--base", fallowParameters.base]),
  ];
  return Object.freeze({
    definition,
    executable: process.execPath,
    args: [binary, ...args],
    fingerprintArgs: definition.argvTemplate,
    displayCommand: [process.execPath, binary, ...args].join(" "),
    effectiveParameters: fallowParameters.effective,
  });
}

export type ProjectCommandResolver = (
  definition: ProjectCommandDefinition,
  projectPath: string,
  signal: AbortSignal | undefined,
  parameters?: unknown,
) => ResolvedProjectCommand | Promise<ResolvedProjectCommand>;

export async function resolveProjectCommand(
  definition: ProjectCommandDefinition,
  projectPath: string,
  signal: AbortSignal | undefined,
  parameters?: unknown,
): Promise<ResolvedProjectCommand> {
  void signal;
  if (definition.applicability === "fallow-binary") {
    return resolveFallowProjectCommand(definition, projectPath, parameters);
  }
  if (
    definition.applicability === "node-script" ||
    definition.applicability === "node-dependency-list" ||
    definition.commandId === "node_project_info"
  ) {
    const { resolveNodeProjectCommand } = await import("./node.ts");
    return resolveNodeProjectCommand(definition, projectPath, parameters);
  }
  return resolveFixedProjectCommand(definition);
}
