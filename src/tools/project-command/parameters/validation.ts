import { isAbsolute } from "node:path";
import { ProjectCommandResolutionError } from "../errors.ts";
import {
  NODE_E2E_GREP_MAX_LENGTH,
  NODE_E2E_PROJECT_MAX_LENGTH,
  PROJECT_COMMAND_MAX_PARAMETER_ITEMS,
  PROJECT_COMMAND_MAX_PATH_LENGTH,
} from "./limits.ts";
import { e2eForwardedArgumentsWithinBudget } from "./e2e.ts";
import { isWithinForwardedArgumentBudget } from "./argument-budget.ts";
import type { NodeE2EParameters } from "./types.ts";

function parameterError(code: string): ProjectCommandResolutionError {
  return new ProjectCommandResolutionError("probe", code);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code <= 0x1f ||
      (code >= 0x80 && code <= 0x9f) ||
      code === 0x7f ||
      code === 0x2028 ||
      code === 0x2029
    ) {
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

function validateE2EText(value: unknown, code: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    hasControlCharacter(value) ||
    value.startsWith("-")
  ) {
    throw parameterError(code);
  }
  return value;
}

function validateE2EInteger(
  value: unknown,
  code: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw parameterError(code);
  }
  return value;
}

function validateE2EBoolean(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") {
    throw parameterError(code);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ValidatedE2EOptions = {
  -readonly [Key in Exclude<keyof NodeE2EParameters, "paths">]?: NodeE2EParameters[Key];
};

function validateE2EProjects(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw parameterError("invalid-e2e-projects");
  }
  if (value.length > PROJECT_COMMAND_MAX_PARAMETER_ITEMS) {
    throw parameterError("too-many-e2e-projects");
  }
  const projects = value.map((project) =>
    validateE2EText(project, "invalid-e2e-project", NODE_E2E_PROJECT_MAX_LENGTH),
  );
  if (new Set(projects).size !== projects.length) {
    throw parameterError("duplicate-e2e-project");
  }
  return Object.freeze([...projects]);
}

function validateE2EOptions(value: Readonly<Record<string, unknown>>): ValidatedE2EOptions {
  const result: ValidatedE2EOptions = {};
  if (value.grep !== undefined) {
    result.grep = validateE2EText(value.grep, "invalid-e2e-grep", NODE_E2E_GREP_MAX_LENGTH);
  }
  const projects = validateE2EProjects(value.projects);
  if (projects !== undefined) {
    result.projects = projects;
  }
  if (value.workers !== undefined) {
    result.workers = validateE2EInteger(value.workers, "invalid-e2e-workers", 1, 64);
  }
  if (value.retries !== undefined) {
    result.retries = validateE2EInteger(value.retries, "invalid-e2e-retries", 0, 10);
  }
  if (value.headed !== undefined) {
    result.headed = validateE2EBoolean(value.headed, "invalid-e2e-headed");
  }
  if (value.list !== undefined) {
    result.list = validateE2EBoolean(value.list, "invalid-e2e-list");
  }
  return result;
}

export function validateNodeE2EParameters(value: unknown): NodeE2EParameters {
  if (value === undefined) {
    return Object.freeze({ paths: Object.freeze([]) });
  }
  if (!isRecord(value)) {
    throw parameterError("invalid-e2e-parameters");
  }
  const allowedKeys = new Set([
    "commandId",
    "paths",
    "grep",
    "projects",
    "workers",
    "retries",
    "headed",
    "list",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw parameterError("invalid-e2e-parameters");
  }
  const result = {
    paths: validateNodeTestPaths(value.paths),
    ...validateE2EOptions(value),
  } satisfies NodeE2EParameters;
  if (!e2eForwardedArgumentsWithinBudget(result)) {
    throw parameterError("e2e-arguments-too-large");
  }
  return Object.freeze(result);
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
