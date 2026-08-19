import { readFile, realpath, stat, lstat } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import type { ProjectCommandDefinition } from "./definitions.ts";

const PROJECT_COMMAND_RESOLUTION_STAGES = [
  "probe",
  "detection",
  "binary-resolution",
  "spawn",
  "timeout",
  "policy",
] as const;

export type ProjectCommandResolutionStage = (typeof PROJECT_COMMAND_RESOLUTION_STAGES)[number];
export type ResolutionStage = ProjectCommandResolutionStage;

export type ResolutionErrorDetail = string | number | boolean | null | readonly string[];
export type ResolutionErrorDetails = Readonly<Record<string, ResolutionErrorDetail>>;

export class ProjectCommandResolutionError extends Error {
  readonly stage: ResolutionStage;
  readonly code: string;
  readonly details: ResolutionErrorDetails;

  constructor(stage: ResolutionStage, code: string, details: ResolutionErrorDetails = {}) {
    super(`Project command resolution failed during ${stage}`);
    this.name = "ProjectCommandResolutionError";
    this.stage = stage;
    this.code = code;
    this.details = Object.freeze({ ...details, stage, code });
  }
}

export function isProjectCommandResolutionError(
  error: unknown,
): error is ProjectCommandResolutionError {
  return error instanceof ProjectCommandResolutionError;
}

export interface ResolvedProjectCommand {
  readonly definition: ProjectCommandDefinition;
  readonly executable: string;
  readonly args: readonly string[];
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
) => ResolvedProjectCommand | Promise<ResolvedProjectCommand>;

export async function resolveProjectCommand(
  definition: ProjectCommandDefinition,
  projectPath: string,
  signal: AbortSignal | undefined,
): Promise<ResolvedProjectCommand> {
  void projectPath;
  void signal;
  return resolveFixedProjectCommand(definition);
}

const SUPPORTED_PACKAGE_MANAGERS = ["npm", "pnpm", "bun", "yarn"] as const;
export type PackageManager = (typeof SUPPORTED_PACKAGE_MANAGERS)[number];

export type PackageManagerAvailability = Readonly<Partial<Record<PackageManager, boolean>>>;
export type PackageManagerAvailabilityInput =
  | PackageManagerAvailability
  | ReadonlySet<PackageManager>
  | readonly PackageManager[];

export interface PackageManagerDetectionInput {
  readonly packageManager?: unknown;
  readonly lockfiles: Iterable<string>;
}

export interface DetectedPackageManager {
  readonly manager: PackageManager;
  readonly version: string | undefined;
  readonly source: "packageManager" | "lockfile" | "default";
}

const PACKAGE_MANAGER_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const PACKAGE_MANAGER_PATTERN = /^(npm|pnpm|bun|yarn)@(.+)$/u;
const PACKAGE_MANAGER_KEYS = new Set<string>(SUPPORTED_PACKAGE_MANAGERS);

function isPackageManager(value: string): value is PackageManager {
  return PACKAGE_MANAGER_KEYS.has(value);
}
const NPM_LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json"]);
const PNPM_LOCKFILES = new Set(["pnpm-lock.yaml"]);
const BUN_LOCKFILES = new Set(["bun.lock", "bun.lockb"]);
const SUPPORTED_LOCKFILES = new Set([
  ...NPM_LOCKFILES,
  ...PNPM_LOCKFILES,
  ...BUN_LOCKFILES,
  "yarn.lock",
]);
const DEFAULT_PACKAGE_MANAGER_AVAILABILITY: PackageManagerAvailability = Object.freeze({
  npm: true,
  pnpm: true,
  bun: true,
  yarn: true,
});

function detectionError(
  code: string,
  details: ResolutionErrorDetails = {},
): ProjectCommandResolutionError {
  return new ProjectCommandResolutionError("detection", code, details);
}

function isAvailabilityRecord(
  value: PackageManagerAvailabilityInput,
): value is PackageManagerAvailability {
  return !Array.isArray(value) && !(value instanceof Set);
}

function availabilityContains(
  availability: PackageManagerAvailabilityInput,
  manager: PackageManager,
): boolean {
  if (availability instanceof Set) {
    return availability.has(manager);
  }
  if (Array.isArray(availability)) {
    return availability.includes(manager);
  }
  if (isAvailabilityRecord(availability)) {
    return availability[manager] === true;
  }
  return false;
}

function ensureAvailable(
  manager: PackageManager,
  availability: PackageManagerAvailabilityInput,
): void {
  if (!availabilityContains(availability, manager)) {
    throw detectionError("package-manager-unavailable", { manager });
  }
}

function completePatternMatch(pattern: RegExp, value: string): RegExpExecArray | undefined {
  const match = pattern.exec(value);
  if (match !== null && match[0] === value) {
    return match;
  }
  return undefined;
}

function parseExplicitPackageManager(value: unknown): { manager: PackageManager; version: string } {
  if (typeof value !== "string") {
    throw detectionError("invalid-package-manager");
  }
  const match = completePatternMatch(PACKAGE_MANAGER_PATTERN, value);
  if (match === undefined) {
    throw detectionError("invalid-package-manager");
  }
  const manager = match[1];
  if (manager === undefined || !isPackageManager(manager)) {
    throw detectionError("invalid-package-manager");
  }
  const version = match[2];
  if (
    version === undefined ||
    completePatternMatch(PACKAGE_MANAGER_VERSION_PATTERN, version) === undefined
  ) {
    throw detectionError("invalid-package-manager");
  }
  return { manager, version };
}

function lockfileManager(lockfiles: Iterable<string>): PackageManager | undefined {
  const managers = new Set<PackageManager>();
  for (const lockfile of lockfiles) {
    if (NPM_LOCKFILES.has(lockfile)) {
      managers.add("npm");
    } else if (PNPM_LOCKFILES.has(lockfile)) {
      managers.add("pnpm");
    } else if (BUN_LOCKFILES.has(lockfile)) {
      managers.add("bun");
    } else if (lockfile === "yarn.lock") {
      continue;
    }
  }
  if (managers.size > 1) {
    throw detectionError("conflicting-lockfiles", {
      managers: [...managers].sort(),
    });
  }
  const manager = managers.values().next().value;
  return manager === undefined ? undefined : manager;
}

export function detectPackageManagerDetails(
  input: PackageManagerDetectionInput,
  availability: PackageManagerAvailabilityInput,
): DetectedPackageManager {
  const hasExplicitPackageManager = Object.prototype.hasOwnProperty.call(input, "packageManager");
  if (hasExplicitPackageManager) {
    const explicit = parseExplicitPackageManager(input.packageManager);
    ensureAvailable(explicit.manager, availability);
    return { manager: explicit.manager, version: explicit.version, source: "packageManager" };
  }
  const detectedLockfileManager = lockfileManager(input.lockfiles);
  const manager = detectedLockfileManager ?? "npm";
  ensureAvailable(manager, availability);
  return {
    manager,
    version: undefined,
    source: detectedLockfileManager === undefined ? "default" : "lockfile",
  };
}

function isPackageManagerDetectionInput(value: unknown): value is PackageManagerDetectionInput {
  return typeof value === "object" && value !== null && "lockfiles" in value;
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.iterator in value;
}

function lockfilesFromUnknown(value: unknown): Iterable<string> {
  if (!isIterable(value)) {
    return [];
  }
  const lockfiles: string[] = [];
  for (const lockfile of value) {
    if (typeof lockfile === "string") {
      lockfiles.push(lockfile);
    }
  }
  return lockfiles;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function availabilityFromUnknown(value: unknown): PackageManagerAvailabilityInput {
  if (value instanceof Set) {
    const available: PackageManager[] = [];
    for (const manager of value) {
      if (typeof manager === "string" && isPackageManager(manager)) {
        available.push(manager);
      }
    }
    return available;
  }
  if (Array.isArray(value)) {
    return value.filter(
      (manager): manager is PackageManager =>
        typeof manager === "string" && isPackageManager(manager),
    );
  }
  if (isRecord(value)) {
    const available: Partial<Record<PackageManager, boolean>> = {};
    for (const manager of SUPPORTED_PACKAGE_MANAGERS) {
      if (value[manager] === true) {
        available[manager] = true;
      }
    }
    return available;
  }
  return {};
}

export function detectPackageManager(
  input: PackageManagerDetectionInput,
  availability: PackageManagerAvailabilityInput,
): PackageManager;
export function detectPackageManager(
  packageManager: unknown,
  lockfiles: Iterable<string>,
  availability: PackageManagerAvailabilityInput,
): PackageManager;
export function detectPackageManager(
  inputOrPackageManager: unknown,
  availabilityOrLockfiles: unknown,
  suppliedAvailability?: PackageManagerAvailabilityInput,
): PackageManager {
  const input: PackageManagerDetectionInput = isPackageManagerDetectionInput(inputOrPackageManager)
    ? inputOrPackageManager
    : {
        packageManager: inputOrPackageManager,
        lockfiles: lockfilesFromUnknown(availabilityOrLockfiles),
      };
  const availability = suppliedAvailability ?? availabilityFromUnknown(availabilityOrLockfiles);
  return detectPackageManagerDetails(input, availability).manager;
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

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function isWithinRoot(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function binaryResolutionError(
  code: string,
  details: ResolutionErrorDetails = {},
): ProjectCommandResolutionError {
  return new ProjectCommandResolutionError("binary-resolution", code, details);
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

export interface ProjectPackageManagerDetectionOptions {
  readonly availability?: PackageManagerAvailabilityInput;
  readonly fileSystem?: Pick<ProjectResolutionFileSystem, "readFile" | "stat">;
}

type ProjectPackageManagerDetectionInput =
  | ProjectPackageManagerDetectionOptions
  | PackageManagerAvailabilityInput;

function isProjectPackageManagerDetectionOptions(
  value: ProjectPackageManagerDetectionInput,
): value is ProjectPackageManagerDetectionOptions {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Set) &&
    (Object.keys(value).length === 0 || "availability" in value || "fileSystem" in value)
  );
}

async function readSupportedLockfiles(
  projectPath: string,
  fileSystem: Pick<ProjectResolutionFileSystem, "stat">,
): Promise<readonly string[]> {
  const present: string[] = [];
  for (const lockfile of SUPPORTED_LOCKFILES) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const stats = await fileSystem.stat(join(projectPath, lockfile));
      if (stats.isFile()) {
        present.push(lockfile);
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw detectionError("lockfile-read-failed", { file: lockfile });
      }
    }
  }
  return present;
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
  options?: ProjectPackageManagerDetectionInput,
): Promise<PackageManager>;
export async function detectProjectPackageManager(
  projectPath: string,
  optionsOrAvailability?: ProjectPackageManagerDetectionInput,
): Promise<PackageManager> {
  const options =
    optionsOrAvailability === undefined
      ? {}
      : isProjectPackageManagerDetectionOptions(optionsOrAvailability)
        ? optionsOrAvailability
        : { availability: optionsOrAvailability };
  const fileSystem = options.fileSystem ?? nodeProjectResolutionFileSystem;
  let packageManager: unknown;
  let hasPackageManager = false;
  try {
    const packageJson = JSON.parse(
      await fileSystem.readFile(join(projectPath, "package.json"), "utf8"),
    ) as unknown;
    if (typeof packageJson !== "object" || packageJson === null || Array.isArray(packageJson)) {
      throw detectionError("invalid-package-manifest");
    }
    hasPackageManager = Object.prototype.hasOwnProperty.call(packageJson, "packageManager");
    if (hasPackageManager) {
      packageManager = (packageJson as { readonly packageManager?: unknown }).packageManager;
    }
  } catch (error) {
    if (error instanceof ProjectCommandResolutionError) {
      throw error;
    }
    if (!isMissingFileError(error)) {
      throw detectionError("invalid-package-manifest");
    }
  }
  const lockfiles = await readSupportedLockfiles(projectPath, fileSystem);
  return detectPackageManager(
    hasPackageManager ? { packageManager, lockfiles } : { lockfiles },
    options.availability ?? DEFAULT_PACKAGE_MANAGER_AVAILABILITY,
  );
}
