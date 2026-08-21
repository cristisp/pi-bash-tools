import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  containsPathspecCharacter,
  GitToolError,
  runGit,
  validateGitText,
  type GitExec,
} from "./execution.ts";

export interface Repository {
  readonly root: string;
  readonly cwd: string;
}

function isInside(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return (
    suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  );
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

function validatePathSyntax(path: string, label: string): void {
  validateGitText(path, label);
  if (isUnsafePath(path)) {
    throw new GitToolError(`${label} is not a safe workspace-relative path`);
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
    throw new GitToolError("Git did not return a repository root");
  }
  try {
    const root = await realpath(rootText);
    const canonicalCwd = await realpath(cwd);
    if (!isInside(root, canonicalCwd)) {
      throw new GitToolError("current workspace is outside the Git repository");
    }
    return { root, cwd: canonicalCwd };
  } catch (error) {
    if (error instanceof GitToolError) {
      throw error;
    }
    throw new GitToolError(`cannot resolve Git repository root: ${String(error)}`);
  }
}

export async function resolvePath(
  repository: Repository,
  input: string,
  label = "path",
): Promise<string> {
  validatePathSyntax(input, label);
  const candidate = resolve(repository.cwd, input);
  if (!isInside(repository.cwd, candidate) || !isInside(repository.root, candidate)) {
    throw new GitToolError(`${label} escapes the workspace or repository`);
  }
  const canonicalAncestor = await existingAncestor(candidate);
  if (canonicalAncestor && !isInside(repository.root, canonicalAncestor)) {
    throw new GitToolError(`${label} escapes the repository through a symlink`);
  }
  const repositoryPath = relative(repository.root, candidate).split(sep).join("/") || ".";
  return repositoryPath;
}

export async function resolvePaths(
  repository: Repository,
  inputs: readonly string[],
  label = "paths",
): Promise<string[]> {
  if (inputs.length === 0) {
    throw new GitToolError(`${label} must not be empty`);
  }
  const paths = await Promise.all(
    inputs.map((input, index) => resolvePath(repository, input, `${label}[${index}]`)),
  );
  if (new Set(paths).size !== paths.length) {
    throw new GitToolError(`${label} must not contain duplicate paths`);
  }
  return paths;
}
