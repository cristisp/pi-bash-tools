import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  getProjectCommandDefinitions,
  type ProjectCommandDefinition,
  type ResolvedCommandLine,
} from "./definitions.ts";
import {
  detectPackageManagerDetailsInternal as detectPackageManagerDetails,
  findPackageManagerExecutableInternal as findPackageManagerExecutable,
  nodeDependencyListArgs as nodeDependencyListArgsInternal,
  supportsNodeDependencyList,
  type DetectedPackageManager,
  type PackageManager,
  type PackageManagerAvailabilityInput,
} from "./package-manager.ts";
import { resolveProjectBinary } from "./binary.ts";
import type { ProjectResolutionFileSystem, ResolvedProjectCommand } from "./resolution.ts";
import { ProjectCommandResolutionError, type ResolutionErrorDetails } from "./errors.ts";
import { normalizeNodeTestParameters, validateNodeTestPaths } from "./parameters.ts";

const NODE_SCRIPT_COMMANDS = [
  { commandId: "node_test", script: "test" },
  { commandId: "node_build", script: "build" },
  { commandId: "node_lint", script: "lint" },
  { commandId: "node_lint_fix", script: "lint:fix" },
  { commandId: "node_typecheck", script: "typecheck" },
  { commandId: "node_format_check", script: "format:check" },
  { commandId: "node_format_write", script: "format" },
] as const;

const FALLOW_COMMAND_IDS = [
  "fallow_dead_code",
  "fallow_dupes",
  "fallow_health",
  "fallow_audit",
  "fallow_list_entry_points",
  "fallow_list_boundaries",
] as const;

const NODE_LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
] as const;

const nodeFileSystem: ProjectResolutionFileSystem = {
  readFile: (path, encoding) => readFile(path, encoding),
  realpath: async (path) => (await import("node:fs/promises")).realpath(path),
  stat,
  lstat: async (path) => (await import("node:fs/promises")).lstat(path),
};

export interface NodePackageManagerInfo {
  readonly manager: PackageManager;
  readonly version: string | null;
  readonly source: DetectedPackageManager["source"];
  readonly executableAvailable: boolean;
}

export interface NodeProjectInfo {
  readonly nodeVersion: string;
  readonly manifestPresent: boolean;
  readonly packageManager: NodePackageManagerInfo | null;
  readonly scripts: readonly string[];
  readonly applicableCommands: readonly string[];
}

type NodeFileSystem = Pick<ProjectResolutionFileSystem, "readFile" | "stat"> &
  Partial<Pick<ProjectResolutionFileSystem, "realpath" | "lstat">>;

interface NodeManifest {
  readonly scripts: Readonly<Record<string, string>>;
  readonly packageManager: unknown;
  readonly hasPackageManager: boolean;
}

interface NodeProjectState {
  readonly manifest: NodeManifest | null;
  readonly lockfiles: readonly string[];
  readonly fallowBinaryAvailable: boolean;
  readonly detected: DetectedPackageManager | null;
  readonly managerExecutable: string | undefined;
  readonly scriptHash: string | null;
  readonly info: NodeProjectInfo;
}

interface NodeProjectStateOptions {
  readonly allowMissing: boolean;
  readonly probeFallow: boolean;
}

export interface NodeProjectResolutionOptions {
  readonly availability?: PackageManagerAvailabilityInput;
  readonly fileSystem?: NodeFileSystem;
  readonly nodeExecutable?: string;
  readonly approvedPackageManagerDirectories?: readonly string[];
}

function resolutionError(
  stage: "probe" | "detection" | "binary-resolution",
  code: string,
  details: ResolutionErrorDetails = {},
): ProjectCommandResolutionError {
  return new ProjectCommandResolutionError(stage, code, details);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(source: string): NodeManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw resolutionError("detection", "invalid-package-manifest");
  }
  if (!isRecord(parsed)) {
    throw resolutionError("detection", "invalid-package-manifest");
  }
  const rawScripts = parsed.scripts;
  if (rawScripts !== undefined && !isRecord(rawScripts)) {
    throw resolutionError("detection", "invalid-package-manifest");
  }
  const scripts: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawScripts ?? {})) {
    if (typeof value !== "string") {
      throw resolutionError("detection", "invalid-package-manifest");
    }
    scripts[name] = value;
  }
  return Object.freeze({
    scripts: Object.freeze(scripts),
    packageManager: parsed.packageManager,
    hasPackageManager: Object.prototype.hasOwnProperty.call(parsed, "packageManager"),
  });
}

async function readManifest(
  projectPath: string,
  fileSystem: NodeFileSystem,
  allowMissing: boolean,
): Promise<NodeManifest | null> {
  let source: string;
  try {
    source = await fileSystem.readFile(join(projectPath, "package.json"), "utf8");
  } catch (error) {
    if (allowMissing && isMissingFileError(error)) {
      return null;
    }
    throw resolutionError(
      "probe",
      isMissingFileError(error) ? "missing-package-manifest" : "manifest-read-failed",
    );
  }
  return parseManifest(source);
}

async function readLockfiles(
  projectPath: string,
  fileSystem: NodeFileSystem,
): Promise<readonly string[]> {
  const lockfileResults = await Promise.all(
    NODE_LOCKFILES.map(async (lockfile) => {
      try {
        const stats = await fileSystem.stat(join(projectPath, lockfile));
        return stats.isFile() ? lockfile : undefined;
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw resolutionError("detection", "lockfile-read-failed");
        }
        return undefined;
      }
    }),
  );
  return Object.freeze(
    lockfileResults.filter(
      (lockfile): lockfile is NonNullable<typeof lockfile> => lockfile !== undefined,
    ),
  );
}

export function canonicalizeNodeScripts(scripts: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(scripts).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
  );
}

export function hashNodeScripts(scripts: Readonly<Record<string, string>>): string {
  return createHash("sha256").update(canonicalizeNodeScripts(scripts), "utf8").digest("hex");
}

function applicableCommands(
  scripts: Readonly<Record<string, string>>,
  fallowBinaryAvailable: boolean,
  dependencyListAvailable: boolean,
): readonly string[] {
  const ids = new Set<string>(["node_project_info"]);
  for (const command of NODE_SCRIPT_COMMANDS) {
    if (Object.prototype.hasOwnProperty.call(scripts, command.script)) {
      ids.add(command.commandId);
    }
  }
  if (dependencyListAvailable) {
    ids.add("node_deps_list");
  }
  if (fallowBinaryAvailable) {
    for (const commandId of FALLOW_COMMAND_IDS) {
      ids.add(commandId);
    }
  }
  return Object.freeze(
    getProjectCommandDefinitions()
      .map((definition) => definition.commandId)
      .filter((commandId) => ids.has(commandId)),
  );
}

function hasSafeBinaryResolutionFileSystem(
  fileSystem: NodeFileSystem,
): fileSystem is ProjectResolutionFileSystem {
  return fileSystem.realpath !== undefined && fileSystem.lstat !== undefined;
}

async function projectBinaryAvailable(
  projectPath: string,
  fileSystem: NodeFileSystem,
): Promise<boolean> {
  if (!hasSafeBinaryResolutionFileSystem(fileSystem)) {
    return false;
  }
  try {
    await resolveProjectBinary(projectPath, "fallow", fileSystem);
    return true;
  } catch (error) {
    if (error instanceof ProjectCommandResolutionError && error.stage === "binary-resolution") {
      return false;
    }
    throw resolutionError("detection", "fallow-binary-probe-failed");
  }
}

async function projectState(
  projectPath: string,
  options: NodeProjectResolutionOptions,
  stateOptions: NodeProjectStateOptions,
): Promise<NodeProjectState> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const manifest = await readManifest(projectPath, fileSystem, stateOptions.allowMissing);
  if (manifest === null) {
    return {
      manifest: null,
      lockfiles: [],
      fallowBinaryAvailable: false,
      detected: null,
      managerExecutable: undefined,
      scriptHash: null,
      info: Object.freeze({
        nodeVersion: process.version,
        manifestPresent: false,
        packageManager: null,
        scripts: Object.freeze([]),
        applicableCommands: Object.freeze(["node_project_info"]),
      }),
    };
  }
  const lockfiles = await readLockfiles(projectPath, fileSystem);
  const fallowBinaryAvailable = stateOptions.probeFallow
    ? await projectBinaryAvailable(projectPath, fileSystem)
    : false;
  const detected = detectPackageManagerDetails(
    manifest.hasPackageManager
      ? { packageManager: manifest.packageManager, lockfiles }
      : { lockfiles },
    options.availability ?? { npm: true, pnpm: true, bun: true, yarn: true },
  );
  const managerExecutable = await findPackageManagerExecutable(detected.manager, {
    fileSystem,
    nodeExecutable: options.nodeExecutable,
    approvedDirectories: options.approvedPackageManagerDirectories,
  });
  const info = Object.freeze({
    nodeVersion: process.version,
    manifestPresent: true,
    packageManager: Object.freeze({
      manager: detected.manager,
      version: detected.version ?? null,
      source: detected.source,
      executableAvailable: managerExecutable !== undefined,
    }),
    scripts: Object.freeze(Object.keys(manifest.scripts).sort()),
    applicableCommands: applicableCommands(
      manifest.scripts,
      fallowBinaryAvailable,
      managerExecutable !== undefined &&
        supportsNodeDependencyList(detected.manager, detected.version),
    ),
  });
  return {
    manifest,
    lockfiles,
    fallowBinaryAvailable,
    detected,
    managerExecutable,
    scriptHash: hashNodeScripts(manifest.scripts),
    info,
  };
}

export async function readNodeProjectInfo(
  projectPath: string,
  options: NodeProjectResolutionOptions = {},
): Promise<NodeProjectInfo> {
  return (
    await projectState(projectPath, options, {
      allowMissing: true,
      probeFallow: true,
    })
  ).info;
}

function commandScript(definition: ProjectCommandDefinition): string {
  const script = definition.fixedScriptKey;
  if (script === undefined) {
    throw resolutionError("probe", "invalid-node-command-definition");
  }
  return script;
}

function displayCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args].join(" ");
}

async function resolveNodeTestParameters(
  definition: ProjectCommandDefinition,
  parameters: unknown,
  projectPath: string,
): Promise<{
  readonly paths: readonly string[];
  readonly effective: Readonly<Record<string, unknown>>;
}> {
  if (definition.commandId !== "node_test") {
    return { paths: [], effective: Object.freeze({}) };
  }
  if (
    parameters !== undefined &&
    (!isRecord(parameters) ||
      Object.keys(parameters).some((key) => key !== "commandId" && key !== "paths"))
  ) {
    throw resolutionError("probe", "invalid-test-parameters");
  }
  const paths = validateNodeTestPaths(
    parameters === undefined || !isRecord(parameters) ? undefined : parameters.paths,
  );
  const normalized = await normalizeNodeTestParameters(paths, projectPath);
  return {
    paths: normalized.paths,
    effective: Object.freeze({ paths: normalized.paths }),
  };
}

export async function resolveNodeProjectCommand(
  definition: ProjectCommandDefinition,
  projectPath: string,
  parameters?: unknown,
  options: NodeProjectResolutionOptions = {},
): Promise<ResolvedProjectCommand> {
  if (definition.commandId === "node_project_info") {
    const state = await projectState(projectPath, options, {
      allowMissing: true,
      probeFallow: true,
    });
    return Object.freeze({
      definition,
      executable: "in-process",
      args: [],
      fingerprintArgs: ["node_project_info"],
      displayCommand: "node_project_info (in-process)",
      effectiveParameters: Object.freeze({}),
      structuredDetails: state.info,
    });
  }
  const state = await projectState(projectPath, options, {
    allowMissing: false,
    probeFallow: false,
  });
  if (state.detected === null || state.manifest === null) {
    throw resolutionError("detection", "package-manager-unavailable");
  }
  if (definition.commandId === "node_deps_list") {
    const args = [
      ...nodeDependencyListArgsInternal(state.detected.manager, state.detected.version),
    ];
    if (state.managerExecutable === undefined) {
      throw resolutionError("binary-resolution", "package-manager-executable-unavailable", {
        manager: state.detected.manager,
      });
    }
    const resolved: ResolvedCommandLine = {
      executable: state.managerExecutable,
      args,
      fingerprintArgs: [state.detected.manager, ...args],
    };
    return Object.freeze({
      definition,
      ...resolved,
      displayCommand: displayCommand(resolved.executable, resolved.args),
      effectiveParameters: Object.freeze({}),
    });
  }
  const script = commandScript(definition);
  if (!Object.prototype.hasOwnProperty.call(state.manifest.scripts, script)) {
    throw resolutionError("probe", "inapplicable-command", {
      commandId: definition.commandId,
      requiredPackageScript: script,
      packageManagerCommand: `${state.detected.manager} run ${script}`,
      availableScripts: Object.keys(state.manifest.scripts).sort(),
      applicableCommands: applicableCommands(
        state.manifest.scripts,
        state.fallowBinaryAvailable,
        state.managerExecutable !== undefined &&
          supportsNodeDependencyList(state.detected.manager, state.detected.version),
      ),
    });
  }
  if (state.managerExecutable === undefined) {
    throw resolutionError("binary-resolution", "package-manager-executable-unavailable", {
      manager: state.detected.manager,
    });
  }
  const nodeParameters = await resolveNodeTestParameters(definition, parameters, projectPath);
  const args = [...definition.args];
  if (nodeParameters.paths.length > 0) {
    args.push("--", ...nodeParameters.paths);
  }
  const resolved: ResolvedCommandLine = {
    executable: state.managerExecutable,
    args,
    fingerprintArgs: definition.argvTemplate,
    scriptHash: state.scriptHash ?? undefined,
  };
  return Object.freeze({
    definition,
    ...resolved,
    displayCommand: displayCommand(resolved.executable, resolved.args),
    effectiveParameters: nodeParameters.effective,
    script: state.manifest.scripts[script],
  });
}
