import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type {
  PackageManagerExecutableResolutionOptionsInternal,
  PackageManagerFileSystemInternal,
  PackageManagerInternal,
} from "./types.ts";

type PackageManager = PackageManagerInternal;
type PackageManagerExecutableResolutionOptions = PackageManagerExecutableResolutionOptionsInternal;
type PackageManagerFileSystem = PackageManagerFileSystemInternal;

const approvedPackageManagerDirectories = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/opt/local/bin",
  "/usr/bin",
  "/bin",
] as const;

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

export async function findPackageManagerExecutableImpl(
  manager: PackageManager,
  options: PackageManagerExecutableResolutionOptions = {},
): Promise<string | undefined> {
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const approvedDirectories = options.approvedDirectories ?? approvedPackageManagerDirectories;
  const fileSystem = options.fileSystem ?? nodePackageManagerExecutableFileSystem;
  const candidates = packageManagerExecutableCandidates(
    manager,
    nodeExecutable,
    approvedDirectories,
  );
  return findPackageManagerExecutableCandidate(candidates, 0, fileSystem);
}
