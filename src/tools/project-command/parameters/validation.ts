import { ProjectCommandResolutionError } from "../errors.ts";
import { hasControlCharacter } from "./text-validation.ts";

export { validateNodeTestPaths, validateWorkspacePathParameter } from "./path-validation.ts";

function parameterError(code: string): ProjectCommandResolutionError {
  return new ProjectCommandResolutionError("probe", code);
}

function hasRevisionPathspecCharacter(value: string): boolean {
  return ["\\", "*", "?", "[", "]"].some((character) => value.includes(character));
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
