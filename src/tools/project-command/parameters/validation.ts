import { isAbsolute } from "node:path";
import { hasControlCharacter } from "./text-validation.ts";
import { ProjectCommandResolutionError } from "../errors.ts";
import { PROJECT_COMMAND_MAX_PARAMETER_ITEMS, PROJECT_COMMAND_MAX_PATH_LENGTH } from "./limits.ts";
import { isWithinForwardedArgumentBudget } from "./argument-budget.ts";

function parameterError(code: string): ProjectCommandResolutionError {
  return new ProjectCommandResolutionError("probe", code);
}

function hasWildcardCharacter(value: string): boolean {
  return ["*", "?", "[", "]", "{", "}"].some((character) => value.includes(character));
}

function hasRevisionPathspecCharacter(value: string): boolean {
  return ["\\", "*", "?", "[", "]"].some((character) => value.includes(character));
}

export function validateWorkspacePathParameter(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > PROJECT_COMMAND_MAX_PATH_LENGTH
  ) {
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
  if (value.length > PROJECT_COMMAND_MAX_PARAMETER_ITEMS) {
    throw parameterError("too-many-test-paths");
  }
  const paths = value.map(validateWorkspacePathParameter);
  if (new Set(paths).size !== paths.length) {
    throw parameterError("duplicate-test-path");
  }
  if (!isWithinForwardedArgumentBudget(paths)) {
    throw parameterError("test-arguments-too-large");
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
