import { isAbsolute, normalize, parse } from "node:path";

import { environmentVariableNamePattern } from "./constants.ts";
import { policyErrorInternal } from "./errors.ts";

export function hasPolicyPathControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function hasPolicyPathWildcard(path: string): boolean {
  return ["*", "?", "[", "]"].some((character) => path.includes(character));
}

function hasNonRootTrailingSeparator(path: string): boolean {
  return (
    path.length > 1 && path !== parse(path).root && (path.endsWith("/") || path.endsWith("\\"))
  );
}

export function isEnvironmentVariableNameInternal(value: string): boolean {
  return environmentVariableNamePattern.test(value);
}

function isValidAbsolutePolicyPath(path: string): boolean {
  return (
    path.length > 0 &&
    isAbsolute(path) &&
    path === normalize(path) &&
    !hasNonRootTrailingSeparator(path) &&
    !hasPolicyPathControlCharacter(path) &&
    !hasPolicyPathWildcard(path)
  );
}

export function validateProjectPathInternal(path: string): string {
  if (!isValidAbsolutePolicyPath(path)) {
    throw policyErrorInternal();
  }
  return path;
}

export function validatePolicyPathInternal(path: string): string {
  if (!isValidAbsolutePolicyPath(path)) {
    throw policyErrorInternal();
  }
  return path;
}
