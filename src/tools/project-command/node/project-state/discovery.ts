import { join } from "node:path";
import { resolveProjectBinary } from "../../binary.ts";
import { ProjectCommandResolutionError } from "../../errors.ts";
import type { ProjectResolutionFileSystem } from "../../resolution.ts";
import type { NodeFileSystem } from "../types.ts";
import { isMissingFileError, projectStateResolutionError } from "./errors.ts";

const NODE_LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
] as const;

export async function readNodeLockfilesInternal(
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
          throw projectStateResolutionError("detection", "lockfile-read-failed");
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

function hasSafeBinaryResolutionFileSystem(
  fileSystem: NodeFileSystem,
): fileSystem is ProjectResolutionFileSystem {
  return fileSystem.realpath !== undefined && fileSystem.lstat !== undefined;
}

export async function projectBinaryAvailableInternal(
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
    throw projectStateResolutionError("detection", "fallow-binary-probe-failed");
  }
}
