import { isAbsolute } from "node:path";
import { ProjectCommandResolutionError } from "../errors.ts";

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
