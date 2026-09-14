import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { isPathWithin } from "../path-containment.ts";
import {
  containsPathspecCharacter,
  gitImplementationError,
  invalidGitRequest,
  invalidGitRequestShape,
  GitToolError,
  runGit,
  validateGitText,
  type GitExec,
} from "./execution.ts";

export interface Repository {
  readonly root: string;
  readonly cwd: string;
}

function isUnsafePath(path: string): boolean {
  const checks = [
    isAbsolute(path),
    /^[A-Za-z]:[\\/]/u.test(path),
    path.includes("\\"),
    path.startsWith(":"),
    path.startsWith("!"),
    path.startsWith("^"),
    /(^|[/])\.\.([/]|$)/u.test(path),
    containsPathspecCharacter(path),
    path.includes(":"),
  ];
  return checks.some(Boolean);
}

function validatePathSyntax(path: unknown, label: string): asserts path is string {
  validateGitText(path, label);
  if (isUnsafePath(path)) {
    throw invalidGitRequest(`${label} is not a safe workspace-relative path`, label);
  }
}

async function existingAncestor(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    const parent = resolve(path, "..");
    return parent === path ? undefined : existingAncestor(parent);
  }
}

export async function resolveRepository(
  exec: GitExec,
  cwd: string,
  signal?: AbortSignal,
): Promise<Repository> {
  const result = await runGit(
    exec,
    ["rev-parse", "--show-toplevel"],
    cwd,
    signal,
    "find repository root",
  );
  const rootText = result.stdout.trim();
  if (!rootText) {
    throw gitImplementationError("Git did not return a repository root", true);
  }
  try {
    const root = await realpath(rootText);
    const canonicalCwd = await realpath(cwd);
    if (!isPathWithin(root, canonicalCwd)) {
      throw gitImplementationError("current workspace is outside the Git repository", true);
    }
    return { root, cwd: canonicalCwd };
  } catch (error) {
    if (error instanceof GitToolError) {
      throw error;
    }
    throw gitImplementationError(`cannot resolve Git repository root: ${String(error)}`, true);
  }
}

export async function resolvePath(
  repository: Repository,
  input: unknown,
  label = "path",
): Promise<string> {
  validatePathSyntax(input, label);
  const candidate = resolve(repository.cwd, input);
  if (!isPathWithin(repository.cwd, candidate) || !isPathWithin(repository.root, candidate)) {
    throw invalidGitRequest(`${label} escapes the workspace or repository`, label);
  }
  const canonicalAncestor = await existingAncestor(candidate);
  if (canonicalAncestor && !isPathWithin(repository.root, canonicalAncestor)) {
    throw invalidGitRequest(`${label} escapes the repository through a symlink`, label);
  }
  const repositoryPath = relative(repository.root, candidate).split(sep).join("/") || ".";
  return repositoryPath;
}

export async function resolvePaths(
  repository: Repository,
  inputs: readonly string[],
  label = "paths",
): Promise<string[]> {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw invalidGitRequestShape(`${label} must not be empty`, label);
  }
  const paths = await Promise.all(
    inputs.map((input, index) => resolvePath(repository, input, `${label}[${index}]`)),
  );
  if (new Set(paths).size !== paths.length) {
    throw invalidGitRequest(`${label} must not contain duplicate paths`, label);
  }
  return paths;
}
