import { lstat as nodeLstat, realpath as nodeRealpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { validatePolicyPath } from "../policy/format.ts";
import {
  FilesystemPathResolutionError,
  asPathResolutionError,
  isMissingPathError,
} from "./path-resolution-diagnostics.ts";

export { isMissingPathError };

export interface CanonicalPathFileSystem {
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
  realpath(path: string): Promise<string>;
}

const nodeFileSystem: CanonicalPathFileSystem = {
  lstat: (path) => nodeLstat(path),
  realpath: (path) => nodeRealpath(path),
};

export function requestPath(path: string | undefined, cwd: string): string {
  const supplied = path === undefined || path.length === 0 ? "." : path;
  const normalized = supplied.startsWith("@") ? supplied.slice(1) || "." : supplied;
  return resolve(cwd, normalized);
}

export async function canonicalMissingPath(
  path: string,
  fileSystem: CanonicalPathFileSystem = nodeFileSystem,
): Promise<string> {
  const missingParts: string[] = [];
  const findExistingAncestor = async (candidate: string): Promise<string> => {
    try {
      return await fileSystem.realpath(candidate);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw asPathResolutionError(error);
      }
      try {
        const stats = await fileSystem.lstat(candidate);
        if (stats.isSymbolicLink()) {
          throw new FilesystemPathResolutionError("symlink", { cause: error });
        }
      } catch (lstatError) {
        if (!isMissingPathError(lstatError)) {
          throw asPathResolutionError(lstatError);
        }
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw asPathResolutionError(error);
      }
      missingParts.unshift(basename(candidate));
      return findExistingAncestor(parent);
    }
  };
  const resolved = await findExistingAncestor(path);
  const joined = join(resolved, ...missingParts);
  try {
    return validatePolicyPath(joined);
  } catch (error) {
    throw asPathResolutionError(error, joined);
  }
}

export async function canonicalExistingPath(
  path: string,
  fileSystem: CanonicalPathFileSystem = nodeFileSystem,
): Promise<string> {
  let canonical: string;
  try {
    canonical = await fileSystem.realpath(path);
  } catch (error) {
    throw asPathResolutionError(error);
  }
  try {
    return validatePolicyPath(canonical);
  } catch (error) {
    throw asPathResolutionError(error, canonical);
  }
}

export async function canonicalRequestPath(
  path: string | undefined,
  cwd: string,
  allowMissingPath: boolean,
): Promise<string> {
  const requested = requestPath(path, cwd);
  return allowMissingPath ? canonicalMissingPath(requested) : canonicalExistingPath(requested);
}
