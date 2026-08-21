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
const FILESYSTEM_SCOPE_KEYS = new Set([
  "allowRead",
  "allowWrite",
  "denyRead",
  "denyWrite",
  "allowMove",
  "denyMove",
  "allowDelete",
  "denyDelete",
]);
const DEFAULT_FILESYSTEM_SCOPE: FilesystemPolicyScope = {
  allowRead: [],
  allowWrite: [],
  denyRead: [],
  denyWrite: [],
  allowMove: [],
  denyMove: [],
  allowDelete: [],
  denyDelete: [],
};

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

function parseOptionalFilesystemPaths(value: unknown): string[] {
  return value === undefined ? [] : parseFilesystemPaths(value);
}

function assertNoFilesystemScopeConflicts(
  pairs: readonly (readonly [readonly string[], readonly string[]])[],
): void {
  if (pairs.some(([allow, deny]) => allow.some((path) => deny.includes(path)))) {
    throw policyErrorInternal();
  }
}

function parseFilesystemScope(value: unknown): FilesystemPolicyScope {
  if (!isPolicyRecordInternal(value)) {
    throw policyErrorInternal();
  }
  assertPolicyAllowedKeysInternal(value, FILESYSTEM_SCOPE_KEYS);
  const allowRead = parseOptionalFilesystemPaths(value.allowRead);
  const allowWrite = parseOptionalFilesystemPaths(value.allowWrite);
  const denyRead = parseOptionalFilesystemPaths(value.denyRead);
  const denyWrite = parseOptionalFilesystemPaths(value.denyWrite);
  const allowMove = parseOptionalFilesystemPaths(value.allowMove);
  const denyMove = parseOptionalFilesystemPaths(value.denyMove);
  const allowDelete = parseOptionalFilesystemPaths(value.allowDelete);
  const denyDelete = parseOptionalFilesystemPaths(value.denyDelete);
  assertNoFilesystemScopeConflicts([
    [allowRead, denyRead],
    [allowWrite, denyWrite],
    [allowMove, denyMove],
    [allowDelete, denyDelete],
  ]);
  return {
    allowRead,
    allowWrite,
    denyRead,
    denyWrite,
    allowMove,
    denyMove,
    allowDelete,
    denyDelete,
  };
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
    global: {
      allowRead: [...DEFAULT_FILESYSTEM_SCOPE.allowRead],
      allowWrite: [...DEFAULT_FILESYSTEM_SCOPE.allowWrite],
      denyRead: [...DEFAULT_FILESYSTEM_SCOPE.denyRead],
      denyWrite: [...DEFAULT_FILESYSTEM_SCOPE.denyWrite],
      allowMove: [...DEFAULT_FILESYSTEM_SCOPE.allowMove],
      denyMove: [...DEFAULT_FILESYSTEM_SCOPE.denyMove],
      allowDelete: [...DEFAULT_FILESYSTEM_SCOPE.allowDelete],
      denyDelete: [...DEFAULT_FILESYSTEM_SCOPE.denyDelete],
    },
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
      ? createEmptyFilesystemPolicyInternal().global
      : parseFilesystemScope(value.global);
  const projects = value.projects === undefined ? {} : parseFilesystemProjects(value.projects);
  return {
    version: FILESYSTEM_POLICY_VERSION,
    global,
    projects,
  };
}
