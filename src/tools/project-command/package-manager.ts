import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { ProjectCommandResolutionError, type ResolutionErrorDetails } from "./errors.ts";

const SUPPORTED_PACKAGE_MANAGERS = ["npm", "pnpm", "bun", "yarn"] as const;
export type PackageManager = (typeof SUPPORTED_PACKAGE_MANAGERS)[number];
const APPROVED_PACKAGE_MANAGER_DIRECTORIES = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/opt/local/bin",
  "/usr/bin",
  "/bin",
] as const;

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

export function supportsNodeDependencyList(
  manager: PackageManager,
  version: string | undefined,
): boolean {
  return manager !== "yarn" || (version !== undefined && /^1\./u.test(version));
}

export function nodeDependencyListArgs(
  manager: PackageManager,
  version: string | undefined,
): readonly string[] {
  if (!supportsNodeDependencyList(manager, version)) {
    throw detectionError("unsupported-yarn-version", {
      manager,
      version: version ?? null,
    });
  }
  switch (manager) {
    case "npm":
      return ["ls", "--depth=0"];
    case "pnpm":
      return ["list", "--depth=0"];
    case "bun":
      return ["pm", "ls"];
    case "yarn":
      return ["list", "--depth=0"];
  }
  throw detectionError("unsupported-package-manager");
}

export interface PackageManagerFileSystem {
  readonly readFile: (path: string, encoding: "utf8") => Promise<string>;
  readonly stat: (path: string) => Promise<import("node:fs").Stats>;
}

const PACKAGE_MANAGER_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const PACKAGE_MANAGER_PATTERN = /^(npm|pnpm|bun|yarn)@(.+)$/u;
const PACKAGE_MANAGER_KEYS = new Set<string>(SUPPORTED_PACKAGE_MANAGERS);
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

function isPackageManager(value: string): value is PackageManager {
  return PACKAGE_MANAGER_KEYS.has(value);
}

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

export function detectPackageManagerDetailsInternal(
  input: PackageManagerDetectionInput,
  availability: PackageManagerAvailabilityInput,
): DetectedPackageManager {
  const hasExplicitPackageManager = Object.prototype.hasOwnProperty.call(input, "packageManager");
  const lockfiles = [...input.lockfiles];
  if (hasExplicitPackageManager) {
    const explicit = parseExplicitPackageManager(input.packageManager);
    ensureAvailable(explicit.manager, availability);
    return { manager: explicit.manager, version: explicit.version, source: "packageManager" };
  }
  if (lockfiles.includes("yarn.lock")) {
    throw detectionError("ambiguous-yarn-lockfile");
  }
  const detectedLockfileManager = lockfileManager(lockfiles);
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

export function detectPackageManagerInternal(
  input: PackageManagerDetectionInput,
  availability: PackageManagerAvailabilityInput,
): PackageManager;
export function detectPackageManagerInternal(
  packageManager: unknown,
  lockfiles: Iterable<string>,
  availability: PackageManagerAvailabilityInput,
): PackageManager;
export function detectPackageManagerInternal(
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
  return detectPackageManagerDetailsInternal(input, availability).manager;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

async function readSupportedLockfiles(
  projectPath: string,
  fileSystem: Pick<PackageManagerFileSystem, "stat">,
): Promise<readonly string[]> {
  const results = await Promise.all(
    [...SUPPORTED_LOCKFILES].map(async (lockfile) => {
      try {
        const stats = await fileSystem.stat(join(projectPath, lockfile));
        return stats.isFile() ? lockfile : undefined;
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw detectionError("lockfile-read-failed", { file: lockfile });
        }
        return undefined;
      }
    }),
  );
  return results.filter((lockfile): lockfile is string => lockfile !== undefined);
}

export interface ProjectPackageManagerDetectionOptions {
  readonly availability?: PackageManagerAvailabilityInput;
  readonly fileSystem?: Pick<PackageManagerFileSystem, "readFile" | "stat">;
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

const nodePackageManagerFileSystem: PackageManagerFileSystem = { readFile, stat };

export function detectProjectPackageManagerInternal(
  projectPath: string,
  options: ProjectPackageManagerDetectionOptions,
): Promise<PackageManager>;
export function detectProjectPackageManagerInternal(
  projectPath: string,
  availability: PackageManagerAvailabilityInput,
): Promise<PackageManager>;
export function detectProjectPackageManagerInternal(
  projectPath: string,
  options?: ProjectPackageManagerDetectionInput,
): Promise<PackageManager>;
export async function detectProjectPackageManagerInternal(
  projectPath: string,
  optionsOrAvailability?: ProjectPackageManagerDetectionInput,
): Promise<PackageManager> {
  const options =
    optionsOrAvailability === undefined
      ? {}
      : isProjectPackageManagerDetectionOptions(optionsOrAvailability)
        ? optionsOrAvailability
        : { availability: optionsOrAvailability };
  const fileSystem = options.fileSystem ?? nodePackageManagerFileSystem;
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
  return detectPackageManagerInternal(
    hasPackageManager ? { packageManager, lockfiles } : { lockfiles },
    options.availability ?? DEFAULT_PACKAGE_MANAGER_AVAILABILITY,
  );
}

export interface PackageManagerExecutableResolutionOptions {
  readonly fileSystem?: Pick<PackageManagerFileSystem, "stat">;
  readonly nodeExecutable?: string;
  readonly approvedDirectories?: readonly string[];
}

const nodePackageManagerExecutableFileSystem: Pick<PackageManagerFileSystem, "stat"> = { stat };

function packageManagerExecutableCandidates(
  manager: PackageManager,
  nodeExecutable: string,
  approvedDirectories: readonly string[],
): readonly string[] {
  const candidates = [join(dirname(nodeExecutable), manager)];
  for (const directory of approvedDirectories) {
    candidates.push(join(directory, manager));
  }
  return [...new Set(candidates)];
}

async function findPackageManagerExecutableCandidate(
  candidates: readonly string[],
  index: number,
  fileSystem: Pick<PackageManagerFileSystem, "stat">,
): Promise<string | undefined> {
  const candidate = candidates[index];
  if (candidate === undefined) {
    return undefined;
  }
  if (!isAbsolute(candidate)) {
    return findPackageManagerExecutableCandidate(candidates, index + 1, fileSystem);
  }
  try {
    const stats = await fileSystem.stat(candidate);
    if (stats.isFile() && (typeof stats.mode !== "number" || (stats.mode & 0o111) !== 0)) {
      return candidate;
    }
  } catch {}
  return findPackageManagerExecutableCandidate(candidates, index + 1, fileSystem);
}

export async function findPackageManagerExecutableInternal(
  manager: PackageManager,
  options: PackageManagerExecutableResolutionOptions = {},
): Promise<string | undefined> {
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const approvedDirectories = options.approvedDirectories ?? APPROVED_PACKAGE_MANAGER_DIRECTORIES;
  const fileSystem = options.fileSystem ?? nodePackageManagerExecutableFileSystem;
  const candidates = packageManagerExecutableCandidates(
    manager,
    nodeExecutable,
    approvedDirectories,
  );
  return findPackageManagerExecutableCandidate(candidates, 0, fileSystem);
}
