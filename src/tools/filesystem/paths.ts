import { lstat as nodeLstat, realpath as nodeRealpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { validatePolicyPath } from "../policy/format.ts";

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

export function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
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
        throw error;
      }
      try {
        const stats = await fileSystem.lstat(candidate);
        if (stats.isSymbolicLink()) {
          throw new Error("Filesystem path contains a symbolic link", { cause: error });
        }
      } catch (lstatError) {
        if (!isMissingPathError(lstatError)) {
          throw lstatError;
        }
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw error;
      }
      missingParts.unshift(basename(candidate));
      return findExistingAncestor(parent);
    }
  };
  return validatePolicyPath(join(await findExistingAncestor(path), ...missingParts));
}

export async function canonicalExistingPath(
  path: string,
  fileSystem: CanonicalPathFileSystem = nodeFileSystem,
): Promise<string> {
  return validatePolicyPath(await fileSystem.realpath(path));
}

export async function canonicalRequestPath(
  path: string | undefined,
  cwd: string,
  allowMissingPath: boolean,
): Promise<string> {
  const requested = requestPath(path, cwd);
  return allowMissingPath ? canonicalMissingPath(requested) : canonicalExistingPath(requested);
}
