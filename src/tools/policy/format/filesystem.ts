import {
  FILESYSTEM_POLICY_VERSION,
  type FilesystemPolicyData,
  type FilesystemPolicyScope,
} from "../types.ts";
import {
  assertPolicyAllowedKeysInternal,
  isPolicyRecordInternal,
  policyErrorInternal,
} from "./errors.ts";
import { validatePolicyPathInternal, validateProjectPathInternal } from "./validation.ts";

const FILESYSTEM_ROOT_KEYS = new Set(["version", "global", "projects"]);
const SCOPE_KEYS = new Set(["allow", "deny"]);
const DEFAULT_FILESYSTEM_SCOPE: FilesystemPolicyScope = { allow: [], deny: [] };

function parseFilesystemPaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw policyErrorInternal();
  }
  const paths = value.map((item) => {
    if (typeof item !== "string") {
      throw policyErrorInternal();
    }
    return validatePolicyPathInternal(item);
  });
  if (new Set(paths).size !== paths.length) {
    throw policyErrorInternal();
  }
  return paths;
}

function parseFilesystemScope(value: unknown): FilesystemPolicyScope {
  if (!isPolicyRecordInternal(value)) {
    throw policyErrorInternal();
  }
  assertPolicyAllowedKeysInternal(value, SCOPE_KEYS);
  const allow = value.allow === undefined ? [] : parseFilesystemPaths(value.allow);
  const deny = value.deny === undefined ? [] : parseFilesystemPaths(value.deny);
  if (allow.some((path) => deny.includes(path))) {
    throw policyErrorInternal();
  }
  return { allow, deny };
}

function parseFilesystemProjects(value: unknown): Readonly<Record<string, FilesystemPolicyScope>> {
  if (!isPolicyRecordInternal(value)) {
    throw policyErrorInternal();
  }
  const projects: Record<string, FilesystemPolicyScope> = {};
  for (const [path, scope] of Object.entries(value)) {
    projects[validateProjectPathInternal(path)] = parseFilesystemScope(scope);
  }
  return projects;
}

export function createEmptyFilesystemPolicyInternal(): FilesystemPolicyData {
  return {
    version: FILESYSTEM_POLICY_VERSION,
    global: { ...DEFAULT_FILESYSTEM_SCOPE },
    projects: {},
  };
}

export function parseFilesystemPolicyInternal(value: unknown): FilesystemPolicyData {
  if (!isPolicyRecordInternal(value)) {
    throw policyErrorInternal();
  }
  assertPolicyAllowedKeysInternal(value, FILESYSTEM_ROOT_KEYS);
  if (value.version !== FILESYSTEM_POLICY_VERSION) {
    throw policyErrorInternal();
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
