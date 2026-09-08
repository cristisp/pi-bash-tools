import {
  detectPackageManagerDetailsImpl,
  detectPackageManagerImpl,
  nodeDependencyListArgsForManager as nodeDependencyListArgsImpl,
  supportsNodeDependencyListForManager as supportsNodeDependencyListImpl,
} from "./package-manager/detection.ts";
import { findPackageManagerExecutableImpl } from "./package-manager/executable.ts";
import { detectProjectPackageManagerImpl } from "./package-manager/project.ts";

export type PackageManager = "npm" | "pnpm" | "bun" | "yarn";

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

export interface PackageManagerFileSystem {
  readonly readFile: (path: string, encoding: "utf8") => Promise<string>;
  readonly stat: (path: string) => Promise<import("node:fs").Stats>;
}

export interface ProjectPackageManagerDetectionOptions {
  readonly availability?: PackageManagerAvailabilityInput;
  readonly fileSystem?: Pick<PackageManagerFileSystem, "readFile" | "stat">;
}

export interface PackageManagerExecutableResolutionOptions {
  readonly fileSystem?: Pick<PackageManagerFileSystem, "stat">;
  readonly nodeExecutable?: string;
  readonly approvedDirectories?: readonly string[];
}

export function supportsNodeDependencyList(
  manager: PackageManager,
  version: string | undefined,
): boolean {
  return supportsNodeDependencyListImpl(manager, version);
}

export function nodeDependencyListArgs(
  manager: PackageManager,
  version: string | undefined,
): readonly string[] {
  return nodeDependencyListArgsImpl(manager, version);
}

export function detectPackageManagerDetailsInternal(
  input: PackageManagerDetectionInput,
  availability: PackageManagerAvailabilityInput,
): DetectedPackageManager {
  return detectPackageManagerDetailsImpl(input, availability);
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
  return detectPackageManagerImpl(
    inputOrPackageManager,
    availabilityOrLockfiles,
    suppliedAvailability,
  );
}

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
  options?: ProjectPackageManagerDetectionOptions | PackageManagerAvailabilityInput,
): Promise<PackageManager>;
export function detectProjectPackageManagerInternal(
  projectPath: string,
  optionsOrAvailability?: ProjectPackageManagerDetectionOptions | PackageManagerAvailabilityInput,
): Promise<PackageManager> {
  return detectProjectPackageManagerImpl(projectPath, optionsOrAvailability);
}

export function findPackageManagerExecutableInternal(
  manager: PackageManager,
  options: PackageManagerExecutableResolutionOptions = {},
): Promise<string | undefined> {
  return findPackageManagerExecutableImpl(manager, options);
}
