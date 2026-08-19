import { readFile, realpath, stat, lstat } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import type { ProjectCommandDefinition, ResolvedCommandLine } from "./definitions.ts";
import { ProjectCommandResolutionError, type ResolutionErrorDetails } from "./errors.ts";
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
  if (definition.applicability === "node-script" || definition.commandId === "node_project_info") {
    const { resolveNodeProjectCommand } = await import("./node.ts");
    return resolveNodeProjectCommand(definition, projectPath, parameters);
  }
  return resolveFixedProjectCommand(definition);
}

export interface ProjectResolutionFileSystem {
  readonly readFile: (path: string, encoding: "utf8") => Promise<string>;
  readonly realpath: (path: string) => Promise<string>;
  readonly stat: (path: string) => Promise<import("node:fs").Stats>;
  readonly lstat: (path: string) => Promise<import("node:fs").Stats>;
}

const nodeProjectResolutionFileSystem: ProjectResolutionFileSystem = {
  readFile: (path, encoding) => readFile(path, encoding),
  realpath,
  stat,
  lstat,
};

function binaryResolutionError(
  code: string,
  details: ResolutionErrorDetails = {},
): ProjectCommandResolutionError {
  return new ProjectCommandResolutionError("binary-resolution", code, details);
}

function isWithinRoot(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function isValidBinaryName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(name) &&
    basename(name) === name
  );
}

export async function resolveProjectBinary(
  projectPath: string,
  binaryName: string,
  fileSystem: ProjectResolutionFileSystem = nodeProjectResolutionFileSystem,
): Promise<string> {
  if (!isValidBinaryName(binaryName)) {
    throw binaryResolutionError("invalid-binary-name");
  }

  let canonicalProjectPath: string;
  try {
    canonicalProjectPath = await fileSystem.realpath(projectPath);
  } catch {
    throw binaryResolutionError("invalid-project-root");
  }

  const nodeModulesPath = join(canonicalProjectPath, "node_modules");
  let canonicalNodeModulesPath: string;
  try {
    canonicalNodeModulesPath = await fileSystem.realpath(nodeModulesPath);
  } catch {
    throw binaryResolutionError("missing-node-modules-root");
  }
  if (!isWithinRoot(canonicalProjectPath, canonicalNodeModulesPath)) {
    throw binaryResolutionError("node-modules-root-escape");
  }

  const candidate = join(canonicalNodeModulesPath, ".bin", binaryName);
  let resolvedTarget: string;
  try {
    resolvedTarget = await fileSystem.realpath(candidate);
  } catch {
    let candidateExists = false;
    try {
      await fileSystem.lstat(candidate);
      candidateExists = true;
    } catch {}
    throw binaryResolutionError(candidateExists ? "dangling-binary" : "missing-binary");
  }
  if (!isWithinRoot(canonicalNodeModulesPath, resolvedTarget)) {
    throw binaryResolutionError("binary-target-escape");
  }

  try {
    const targetStats = await fileSystem.stat(resolvedTarget);
    if (!targetStats.isFile()) {
      throw binaryResolutionError("binary-not-file");
    }
  } catch (error) {
    if (error instanceof ProjectCommandResolutionError) {
      throw error;
    }
    throw binaryResolutionError("binary-stat-failed");
  }
  return resolvedTarget;
}
