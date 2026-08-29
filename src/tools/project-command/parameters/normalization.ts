import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ProjectCommandResolutionError } from "../errors.ts";
import { validateNodeTestPaths } from "./validation.ts";
import type { NodeTestParameters } from "./types.ts";

function pathResolutionError(): ProjectCommandResolutionError {
  return new ProjectCommandResolutionError("probe", "test-path-outside-workspace");
}

function isContained(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot !== "" && !pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot);
}

async function normalizeNodeTestPath(path: string, canonicalProjectPath: string): Promise<string> {
  const lexicalTarget = resolve(canonicalProjectPath, path);
  if (!isContained(canonicalProjectPath, lexicalTarget)) {
    throw pathResolutionError();
  }
  let target: string;
  try {
    target = await realpath(lexicalTarget);
  } catch {
    throw pathResolutionError();
  }
  if (!isContained(canonicalProjectPath, target)) {
    throw pathResolutionError();
  }
  const normalizedPath = relative(canonicalProjectPath, target);
  if (normalizedPath === "" || normalizedPath.startsWith("..") || isAbsolute(normalizedPath)) {
    throw pathResolutionError();
  }
  return normalizedPath.split("\\").join("/");
}

async function normalizePaths(
  paths: readonly string[],
  canonicalProjectPath: string,
): Promise<readonly string[]> {
  const normalized = await Promise.all(
    paths.map((path) => normalizeNodeTestPath(path, canonicalProjectPath)),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new ProjectCommandResolutionError("probe", "duplicate-test-path");
  }
  return Object.freeze(normalized);
}

export async function normalizeNodeTestParametersInternal(
  value: unknown,
  canonicalProjectPath: string,
): Promise<NodeTestParameters> {
  const paths = validateNodeTestPaths(value);
  return Object.freeze({ paths: await normalizePaths(paths, canonicalProjectPath) });
}
