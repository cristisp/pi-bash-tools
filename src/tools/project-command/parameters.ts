import { isAbsolute, relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { ProjectCommandResolutionError } from "./errors.ts";

export interface ProjectCommandParameterDeclaration {
  readonly name: string;
  readonly kind: "workspace-paths" | "revision";
  readonly required: boolean;
  readonly mapping: "repeated-after-separator" | "flag-value";
}

export const NODE_TEST_PATH_PATTERN =
  "^(?!-)(?!/)(?![A-Za-z]:[\\\\/])(?!.*[\\\\*?\\[\\]{}\\u0000-\\u001f\\u007f])(?!.*(?:^|/)\\.{1,2}(?:/|$)).+$";

export const NODE_TEST_PARAMETERS = Object.freeze([
  Object.freeze({
    name: "paths",
    kind: "workspace-paths" as const,
    required: false,
    mapping: "repeated-after-separator" as const,
  }),
]);

export const FALLOW_AUDIT_PARAMETERS = Object.freeze([
  Object.freeze({
    name: "base",
    kind: "revision" as const,
    required: true,
    mapping: "flag-value" as const,
  }),
]);

export const FALLOW_REVISION_PATTERN =
  "^(?!-)(?!.*--)(?!.*:)(?!.*\\s)(?!.*[\\\\*?\\[\\]])[A-Za-z0-9_./@^~{}+=,-]+$";

export type NodeTestParameters = Readonly<{ paths: readonly string[] }>;

function parameterError(code: string): ProjectCommandResolutionError {
  return new ProjectCommandResolutionError("probe", code);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function hasWildcardCharacter(value: string): boolean {
  return ["*", "?", "[", "]", "{", "}"].some((character) => value.includes(character));
}

function hasRevisionPathspecCharacter(value: string): boolean {
  return ["\\", "*", "?", "[", "]"].some((character) => value.includes(character));
}

export function validateWorkspacePathParameter(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw parameterError("invalid-test-path");
  }
  if (
    hasControlCharacter(value) ||
    value.includes("\\") ||
    hasWildcardCharacter(value) ||
    value.startsWith("-") ||
    isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/u.test(value)
  ) {
    throw parameterError("invalid-test-path");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment.length === 0)) {
    throw parameterError("invalid-test-path");
  }
  return value;
}

export function validateNodeTestPaths(value: unknown): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw parameterError("invalid-test-paths");
  }
  const paths = value.map(validateWorkspacePathParameter);
  if (new Set(paths).size !== paths.length) {
    throw parameterError("duplicate-test-path");
  }
  return Object.freeze([...paths]);
}

export function validateProjectCommandRevision(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    hasControlCharacter(value) ||
    value.startsWith("-") ||
    value.includes("--") ||
    value.includes(":") ||
    /\s/u.test(value) ||
    hasRevisionPathspecCharacter(value) ||
    !/^[A-Za-z0-9_./@^~{}+=,-]+$/u.test(value)
  ) {
    throw parameterError("invalid-revision");
  }
  return value;
}

function pathResolutionError(): ProjectCommandResolutionError {
  return parameterError("test-path-outside-workspace");
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

export async function normalizeNodeTestParameters(
  value: unknown,
  canonicalProjectPath: string,
): Promise<NodeTestParameters> {
  const paths = validateNodeTestPaths(value);
  const normalized = await Promise.all(
    paths.map((path) => normalizeNodeTestPath(path, canonicalProjectPath)),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw parameterError("duplicate-test-path");
  }
  return Object.freeze({ paths: Object.freeze(normalized) });
}
