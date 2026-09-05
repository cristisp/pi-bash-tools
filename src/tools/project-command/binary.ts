import { readFile, realpath, stat, lstat } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { ProjectCommandResolutionError, type ResolutionErrorDetails } from "./errors.ts";
import { nearestExistingPaths, withNearestExistingPaths } from "./resolution-nearest-paths.ts";

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

async function binaryResolutionError(
  code: string,
  path: string,
  fileSystem: ProjectResolutionFileSystem,
  details: ResolutionErrorDetails = {},
): Promise<ProjectCommandResolutionError> {
  const nearest = await nearestExistingPaths(path, fileSystem);
  return new ProjectCommandResolutionError(
    "binary-resolution",
    code,
    withNearestExistingPaths(details, nearest),
  );
}

function isWithinRoot(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
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
    throw await binaryResolutionError("invalid-binary-name", projectPath, fileSystem);
  }

  let canonicalProjectPath: string;
  try {
    canonicalProjectPath = await fileSystem.realpath(projectPath);
  } catch {
    throw await binaryResolutionError("invalid-project-root", projectPath, fileSystem);
  }

  const nodeModulesPath = join(canonicalProjectPath, "node_modules");
  let canonicalNodeModulesPath: string;
  try {
    canonicalNodeModulesPath = await fileSystem.realpath(nodeModulesPath);
  } catch {
    throw await binaryResolutionError("missing-node-modules-root", nodeModulesPath, fileSystem);
  }
  if (!isWithinRoot(canonicalProjectPath, canonicalNodeModulesPath)) {
    throw await binaryResolutionError(
      "node-modules-root-escape",
      canonicalNodeModulesPath,
      fileSystem,
    );
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
    throw await binaryResolutionError(
      candidateExists ? "dangling-binary" : "missing-binary",
      candidate,
      fileSystem,
    );
  }
  if (!isWithinRoot(canonicalNodeModulesPath, resolvedTarget)) {
    throw await binaryResolutionError("binary-target-escape", resolvedTarget, fileSystem);
  }

  try {
    const targetStats = await fileSystem.stat(resolvedTarget);
    if (!targetStats.isFile()) {
      throw await binaryResolutionError("binary-not-file", resolvedTarget, fileSystem);
    }
  } catch (error) {
    if (error instanceof ProjectCommandResolutionError) {
      throw error;
    }
    throw await binaryResolutionError("binary-stat-failed", resolvedTarget, fileSystem);
  }
  return resolvedTarget;
}
