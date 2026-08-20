import { isAbsolute, normalize, parse } from "node:path";
import {
  ENVIRONMENT_POLICY_VERSION,
  FILESYSTEM_POLICY_VERSION,
  type EnvironmentPolicyData,
  type EnvironmentPolicyScope,
  type FilesystemPolicyData,
  type FilesystemPolicyScope,
} from "./types.ts";

export const DEFAULT_CONFIRMATION_TIMEOUT_MS = 120_000;
export const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const ROOT_KEYS = new Set(["version", "confirmationTimeoutMs", "global", "projects"]);
const FILESYSTEM_ROOT_KEYS = new Set(["version", "global", "projects"]);
const SCOPE_KEYS = new Set(["allow", "deny"]);
const DEFAULT_SCOPE: EnvironmentPolicyScope = { allow: [], deny: [] };
const DEFAULT_FILESYSTEM_SCOPE: FilesystemPolicyScope = { allow: [], deny: [] };

export function policyError(): Error {
  return new Error("Environment policy is invalid or unreadable");
}

export function isPolicyRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertPolicyAllowedKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw policyError();
    }
  }
}

export function isEnvironmentVariableName(value: string): boolean {
  return ENVIRONMENT_VARIABLE_NAME_PATTERN.test(value);
}

function parseEnvironmentVariableNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw policyError();
  }
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isEnvironmentVariableName(item)) {
      throw policyError();
    }
    names.push(item);
  }
  if (new Set(names).size !== names.length) {
    throw policyError();
  }
  return names;
}

function parseScope(value: unknown): EnvironmentPolicyScope {
  if (!isPolicyRecord(value)) {
    throw policyError();
  }
  assertPolicyAllowedKeys(value, SCOPE_KEYS);
  const allow = value.allow === undefined ? [] : parseEnvironmentVariableNames(value.allow);
  const deny = value.deny === undefined ? [] : parseEnvironmentVariableNames(value.deny);
  if (allow.some((name) => deny.includes(name))) {
    throw policyError();
  }
  return { allow, deny };
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function hasWildcard(path: string): boolean {
  return ["*", "?", "[", "]"].some((character) => path.includes(character));
}

function hasNonRootTrailingSeparator(path: string): boolean {
  return (
    path.length > 1 && path !== parse(path).root && (path.endsWith("/") || path.endsWith("\\"))
  );
}

export function validateProjectPath(path: string): string {
  if (!isAbsolute(path) || path.length === 0) {
    throw policyError();
  }
  if (
    path !== normalize(path) ||
    hasNonRootTrailingSeparator(path) ||
    hasControlCharacter(path) ||
    hasWildcard(path)
  ) {
    throw policyError();
  }
  return path;
}

export function validatePolicyPath(path: string): string {
  if (
    !isAbsolute(path) ||
    path.length === 0 ||
    path !== normalize(path) ||
    hasNonRootTrailingSeparator(path) ||
    hasControlCharacter(path) ||
    hasWildcard(path)
  ) {
    throw policyError();
  }
  return path;
}

function parseProjects(value: unknown): Readonly<Record<string, EnvironmentPolicyScope>> {
  if (!isPolicyRecord(value)) {
    throw policyError();
  }
  const projects: Record<string, EnvironmentPolicyScope> = {};
  for (const [path, scope] of Object.entries(value)) {
    projects[validateProjectPath(path)] = parseScope(scope);
  }
  return projects;
}

function parseFilesystemPaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw policyError();
  }
  const paths = value.map((item) => {
    if (typeof item !== "string") {
      throw policyError();
    }
    return validatePolicyPath(item);
  });
  if (new Set(paths).size !== paths.length) {
    throw policyError();
  }
  return paths;
}

function parseFilesystemScope(value: unknown): FilesystemPolicyScope {
  if (!isPolicyRecord(value)) {
    throw policyError();
  }
  assertPolicyAllowedKeys(value, SCOPE_KEYS);
  const allow = value.allow === undefined ? [] : parseFilesystemPaths(value.allow);
  const deny = value.deny === undefined ? [] : parseFilesystemPaths(value.deny);
  if (allow.some((path) => deny.includes(path))) {
    throw policyError();
  }
  return { allow, deny };
}

function parseFilesystemProjects(value: unknown): Readonly<Record<string, FilesystemPolicyScope>> {
  if (!isPolicyRecord(value)) {
    throw policyError();
  }
  const projects: Record<string, FilesystemPolicyScope> = {};
  for (const [path, scope] of Object.entries(value)) {
    projects[validateProjectPath(path)] = parseFilesystemScope(scope);
  }
  return projects;
}

export function createEmptyEnvironmentPolicy(): EnvironmentPolicyData {
  return {
    version: ENVIRONMENT_POLICY_VERSION,
    confirmationTimeoutMs: DEFAULT_CONFIRMATION_TIMEOUT_MS,
    global: { ...DEFAULT_SCOPE },
    projects: {},
  };
}

export function createEmptyFilesystemPolicy(): FilesystemPolicyData {
  return {
    version: FILESYSTEM_POLICY_VERSION,
    global: { ...DEFAULT_FILESYSTEM_SCOPE },
    projects: {},
  };
}

export function parseEnvironmentPolicy(text: string): EnvironmentPolicyData {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw policyError();
  }
  if (!isPolicyRecord(value)) {
    throw policyError();
  }
  assertPolicyAllowedKeys(value, ROOT_KEYS);
  if (value.version !== ENVIRONMENT_POLICY_VERSION) {
    throw policyError();
  }
  const timeout: unknown = value.confirmationTimeoutMs;
  if (
    timeout !== undefined &&
    (typeof timeout !== "number" ||
      !Number.isSafeInteger(timeout) ||
      timeout < 0 ||
      timeout > 2_147_483_647)
  ) {
    throw policyError();
  }
  const global = value.global === undefined ? { ...DEFAULT_SCOPE } : parseScope(value.global);
  const projects = value.projects === undefined ? {} : parseProjects(value.projects);
  return {
    version: ENVIRONMENT_POLICY_VERSION,
    confirmationTimeoutMs: typeof timeout === "number" ? timeout : DEFAULT_CONFIRMATION_TIMEOUT_MS,
    global,
    projects,
  };
}

export function parseFilesystemPolicy(value: unknown): FilesystemPolicyData {
  if (!isPolicyRecord(value)) {
    throw policyError();
  }
  assertPolicyAllowedKeys(value, FILESYSTEM_ROOT_KEYS);
  if (value.version !== FILESYSTEM_POLICY_VERSION) {
    throw policyError();
  }
  const global =
    value.global === undefined
      ? { ...DEFAULT_FILESYSTEM_SCOPE }
      : parseFilesystemScope(value.global);
  const projects = value.projects === undefined ? {} : parseFilesystemProjects(value.projects);
  return {
    version: FILESYSTEM_POLICY_VERSION,
    global,
    projects,
  };
}

export function serializePolicy(policy: EnvironmentPolicyData): string {
  const projects: Record<string, EnvironmentPolicyScope> = {};
  for (const path of Object.keys(policy.projects).sort()) {
    const scope = policy.projects[path];
    if (scope !== undefined) {
      projects[path] = {
        allow: [...scope.allow],
        deny: [...scope.deny],
      };
    }
  }
  return `${JSON.stringify(
    {
      version: ENVIRONMENT_POLICY_VERSION,
      confirmationTimeoutMs: policy.confirmationTimeoutMs,
      global: {
        allow: [...policy.global.allow],
        deny: [...policy.global.deny],
      },
      projects,
    },
    null,
    2,
  )}\n`;
}
