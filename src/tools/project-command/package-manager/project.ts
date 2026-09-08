import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { ProjectCommandResolutionError, type ResolutionErrorDetails } from "../errors.ts";
import {
  defaultPackageManagerAvailability,
  detectPackageManagerImpl,
  supportedLockfiles,
} from "./detection.ts";
import type {
  PackageManagerAvailabilityInputInternal,
  PackageManagerFileSystemInternal,
  PackageManagerInternal,
  ProjectPackageManagerDetectionOptionsInternal,
} from "./types.ts";

type PackageManager = PackageManagerInternal;
type PackageManagerAvailabilityInput = PackageManagerAvailabilityInputInternal;
type PackageManagerFileSystem = PackageManagerFileSystemInternal;
type ProjectPackageManagerDetectionOptions = ProjectPackageManagerDetectionOptionsInternal;
type ProjectPackageManagerDetectionInput =
  | ProjectPackageManagerDetectionOptions
  | PackageManagerAvailabilityInput;

function detectionError(
  code: string,
  details: ResolutionErrorDetails = {},
): ProjectCommandResolutionError {
  return new ProjectCommandResolutionError("detection", code, details);
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
    [...supportedLockfiles].map(async (lockfile) => {
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

export function detectProjectPackageManagerImpl(
  projectPath: string,
  options: ProjectPackageManagerDetectionOptions,
): Promise<PackageManager>;
export function detectProjectPackageManagerImpl(
  projectPath: string,
  availability: PackageManagerAvailabilityInput,
): Promise<PackageManager>;
export function detectProjectPackageManagerImpl(
  projectPath: string,
  options?: ProjectPackageManagerDetectionInput,
): Promise<PackageManager>;
export async function detectProjectPackageManagerImpl(
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
  return detectPackageManagerImpl(
    hasPackageManager ? { packageManager, lockfiles } : { lockfiles },
    options.availability ?? defaultPackageManagerAvailability,
  );
}
