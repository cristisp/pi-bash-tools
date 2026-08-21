import { ProjectCommandResolutionError, type ResolutionErrorDetails } from "../errors.ts";
import {
  supportedPackageManagers,
  type DetectedPackageManagerInternal,
  type PackageManagerAvailabilityInputInternal,
  type PackageManagerAvailabilityInternal,
  type PackageManagerDetectionInputInternal,
  type PackageManagerInternal,
} from "./types.ts";

type DetectedPackageManager = DetectedPackageManagerInternal;
type PackageManager = PackageManagerInternal;
type PackageManagerAvailability = PackageManagerAvailabilityInternal;
type PackageManagerAvailabilityInput = PackageManagerAvailabilityInputInternal;
type PackageManagerDetectionInput = PackageManagerDetectionInputInternal;

export const defaultPackageManagerAvailability: PackageManagerAvailabilityInternal = Object.freeze({
  npm: true,
  pnpm: true,
  bun: true,
  yarn: true,
});

const PACKAGE_MANAGER_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const PACKAGE_MANAGER_PATTERN = /^(npm|pnpm|bun|yarn)@(.+)$/u;
const PACKAGE_MANAGER_KEYS = new Set<string>(supportedPackageManagers);
const NPM_LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json"]);
const PNPM_LOCKFILES = new Set(["pnpm-lock.yaml"]);
const BUN_LOCKFILES = new Set(["bun.lock", "bun.lockb"]);
export const supportedLockfiles = new Set([
  ...NPM_LOCKFILES,
  ...PNPM_LOCKFILES,
  ...BUN_LOCKFILES,
  "yarn.lock",
]);

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

export function detectPackageManagerDetailsImpl(
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
    for (const manager of supportedPackageManagers) {
      if (value[manager] === true) {
        available[manager] = true;
      }
    }
    return available;
  }
  return {};
}

export function detectPackageManagerImpl(
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
  return detectPackageManagerDetailsImpl(input, availability).manager;
}

export function supportsNodeDependencyListForManager(
  manager: PackageManager,
  version: string | undefined,
): boolean {
  return manager !== "yarn" || (version !== undefined && /^1\./u.test(version));
}

export function nodeDependencyListArgsForManager(
  manager: PackageManager,
  version: string | undefined,
): readonly string[] {
  if (!supportsNodeDependencyListForManager(manager, version)) {
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
