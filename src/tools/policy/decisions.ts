import { isAbsolute, relative, sep } from "node:path";
import {
  commandIdentityKey,
  copyEnvironmentIntoPolicyDocument,
  copyFilesystemIntoPolicyDocument,
  copyProjectCommandsIntoPolicyDocument,
  createEmptyCommandPolicy,
  validateCommandIdentity,
} from "./document.ts";
import {
  createEmptyFilesystemPolicy,
  isEnvironmentVariableName,
  policyError,
  validatePolicyPath,
  validateProjectPath,
} from "./format.ts";
import type {
  CommandIdentity,
  CommandPolicyData,
  CommandPolicyScope,
  EnvironmentPolicyData,
  EnvironmentPolicyScope,
  FilesystemAccess,
  FilesystemPolicyData,
  FilesystemPolicyScope,
  LoadedPolicy,
  PolicyAuthorization,
  PolicyDecision,
  PolicyDocument,
} from "./types.ts";

interface MutableEnvironmentScope {
  allow: string[];
  deny: string[];
}

type MutableEnvironmentPolicy = {
  version: 1;
  confirmationTimeoutMs: number;
  global: MutableEnvironmentScope;
  projects: Record<string, MutableEnvironmentScope>;
};

interface MutableFilesystemScope {
  allowRead: string[];
  allowWrite: string[];
  denyRead: string[];
  denyWrite: string[];
  allowMove: string[];
  denyMove: string[];
  allowDelete: string[];
  denyDelete: string[];
}

type MutableFilesystemPolicy = {
  version: 2;
  global: MutableFilesystemScope;
  projects: Record<string, MutableFilesystemScope>;
};

interface MutableCommandScope {
  allow: CommandIdentity[];
  deny: CommandIdentity[];
}

interface MutableCommandPolicy {
  version: 1;
  global: MutableCommandScope;
  projects: Record<string, MutableCommandScope>;
}

function copyEnvironmentScope(scope: EnvironmentPolicyScope | undefined): MutableEnvironmentScope {
  return scope === undefined
    ? { allow: [], deny: [] }
    : { allow: [...scope.allow], deny: [...scope.deny] };
}

function copyEnvironmentPolicy(policy: EnvironmentPolicyData): MutableEnvironmentPolicy {
  const projects: Record<string, MutableEnvironmentScope> = {};
  for (const [path, scope] of Object.entries(policy.projects)) {
    projects[path] = copyEnvironmentScope(scope);
  }
  return {
    version: 1,
    confirmationTimeoutMs: policy.confirmationTimeoutMs,
    global: copyEnvironmentScope(policy.global),
    projects,
  };
}

function copyFilesystemScope(scope: FilesystemPolicyScope | undefined): MutableFilesystemScope {
  return scope === undefined
    ? {
        allowRead: [],
        allowWrite: [],
        denyRead: [],
        denyWrite: [],
        allowMove: [],
        denyMove: [],
        allowDelete: [],
        denyDelete: [],
      }
    : {
        allowRead: [...scope.allowRead],
        allowWrite: [...scope.allowWrite],
        denyRead: [...scope.denyRead],
        denyWrite: [...scope.denyWrite],
        allowMove: [...scope.allowMove],
        denyMove: [...scope.denyMove],
        allowDelete: [...scope.allowDelete],
        denyDelete: [...scope.denyDelete],
      };
}

function copyFilesystemPolicy(policy: FilesystemPolicyData): MutableFilesystemPolicy {
  const projects: Record<string, MutableFilesystemScope> = {};
  for (const [path, scope] of Object.entries(policy.projects)) {
    projects[path] = copyFilesystemScope(scope);
  }
  return {
    version: 2,
    global: copyFilesystemScope(policy.global),
    projects,
  };
}

function copyCommandScope(scope: CommandPolicyScope | undefined): MutableCommandScope {
  return scope === undefined
    ? { allow: [], deny: [] }
    : { allow: [...scope.allow], deny: [...scope.deny] };
}

function copyCommandPolicy(policy: CommandPolicyData): MutableCommandPolicy {
  const projects: Record<string, MutableCommandScope> = {};
  for (const [path, scope] of Object.entries(policy.projects)) {
    projects[path] = copyCommandScope(scope);
  }
  return {
    version: 1,
    global: copyCommandScope(policy.global),
    projects,
  };
}

function isDecision(value: string): value is PolicyDecision {
  return (
    value === "deny-global" ||
    value === "deny-project" ||
    value === "allow-global" ||
    value === "allow-project"
  );
}

const OPPOSITE_DECISION: Record<PolicyDecision, PolicyDecision> = {
  "deny-global": "allow-global",
  "deny-project": "allow-project",
  "allow-global": "deny-global",
  "allow-project": "deny-project",
};

function environmentDecisionScope(
  policy: MutableEnvironmentPolicy,
  projectPath: string,
  decision: PolicyDecision,
): MutableEnvironmentScope {
  return decision.endsWith("global")
    ? policy.global
    : (policy.projects[projectPath] ?? (policy.projects[projectPath] = { allow: [], deny: [] }));
}

function existingEnvironmentScope(
  policy: EnvironmentPolicyData,
  projectPath: string,
  decision: PolicyDecision,
): EnvironmentPolicyScope | undefined {
  return decision.endsWith("global") ? policy.global : policy.projects[projectPath];
}

function environmentScopeContains(
  scope: EnvironmentPolicyScope | undefined,
  decision: PolicyDecision,
  key: string,
): boolean {
  const list = decision.startsWith("allow") ? scope?.allow : scope?.deny;
  return list?.includes(key) ?? false;
}

export function applyEnvironmentPolicyDecision(
  document: PolicyDocument,
  projectPath: string,
  key: string,
  decision: PolicyDecision,
): PolicyDocument {
  if (!isDecision(decision)) {
    throw policyError();
  }
  validateProjectPath(projectPath);
  if (!isEnvironmentVariableName(key)) {
    throw policyError();
  }
  const environment = document.environment;
  const scope = existingEnvironmentScope(environment, projectPath, decision);
  if (environmentScopeContains(scope, OPPOSITE_DECISION[decision], key)) {
    throw policyError();
  }
  if (environmentScopeContains(scope, decision, key)) {
    return document;
  }
  const next = copyEnvironmentPolicy(environment);
  const target = environmentDecisionScope(next, projectPath, decision);
  const list = decision.startsWith("allow") ? target.allow : target.deny;
  list.push(key);
  return copyEnvironmentIntoPolicyDocument(document, next);
}

function isPathWithin(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return (
    suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
  );
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathWithin(left, right) || isPathWithin(right, left);
}

function filesystemDecisionScope(
  policy: MutableFilesystemPolicy,
  projectPath: string,
  decision: PolicyDecision,
): MutableFilesystemScope {
  return decision.endsWith("global")
    ? policy.global
    : (policy.projects[projectPath] ??
        (policy.projects[projectPath] = {
          allowRead: [],
          allowWrite: [],
          denyRead: [],
          denyWrite: [],
          allowMove: [],
          denyMove: [],
          allowDelete: [],
          denyDelete: [],
        }));
}

function existingFilesystemScope(
  policy: FilesystemPolicyData,
  projectPath: string,
  decision: PolicyDecision,
): FilesystemPolicyScope | undefined {
  return decision.endsWith("global") ? policy.global : policy.projects[projectPath];
}

type FilesystemScopeKey =
  | "allowRead"
  | "allowWrite"
  | "denyRead"
  | "denyWrite"
  | "allowMove"
  | "denyMove"
  | "allowDelete"
  | "denyDelete";

const FILESYSTEM_ACCESS_KEYS: Record<
  FilesystemAccess,
  { readonly allow: FilesystemScopeKey; readonly deny: FilesystemScopeKey }
> = {
  read: { allow: "allowRead", deny: "denyRead" },
  write: { allow: "allowWrite", deny: "denyWrite" },
  move: { allow: "allowMove", deny: "denyMove" },
  delete: { allow: "allowDelete", deny: "denyDelete" },
};

function filesystemEntries(
  scope: (FilesystemPolicyScope | MutableFilesystemScope) | undefined,
  access: FilesystemAccess,
  decision: PolicyDecision,
): readonly string[] | undefined {
  if (scope === undefined) {
    return undefined;
  }
  const keys = FILESYSTEM_ACCESS_KEYS[access];
  return scope[decision.startsWith("allow") ? keys.allow : keys.deny];
}

function filesystemScopeContains(
  scope: FilesystemPolicyScope | undefined,
  access: FilesystemAccess,
  decision: PolicyDecision,
  path: string,
): boolean {
  const entries = filesystemEntries(scope, access, decision);
  return (
    entries?.some((entry) =>
      decision.startsWith("allow") ? isPathWithin(entry, path) : pathsOverlap(entry, path),
    ) ?? false
  );
}

function filesystemScopeHasExactPath(
  scope: FilesystemPolicyScope | undefined,
  access: FilesystemAccess,
  decision: PolicyDecision,
  path: string,
): boolean {
  return filesystemEntries(scope, access, decision)?.includes(path) ?? false;
}

function appendFilesystemEntry(
  scope: MutableFilesystemScope,
  access: FilesystemAccess,
  decision: PolicyDecision,
  path: string,
): void {
  const keys = FILESYSTEM_ACCESS_KEYS[access];
  scope[decision.startsWith("allow") ? keys.allow : keys.deny].push(path);
}

function filesystemPolicyForDocument(document: PolicyDocument): FilesystemPolicyData {
  return document.version === 4 ? document.filesystem : createEmptyFilesystemPolicy();
}

function isFilesystemAccess(value: string): value is FilesystemAccess {
  return value === "read" || value === "write" || value === "move" || value === "delete";
}

export function applyFilesystemPolicyDecision(
  document: PolicyDocument,
  projectPath: string,
  path: string,
  decision: PolicyDecision,
  access: FilesystemAccess = "read",
): PolicyDocument {
  if (!isDecision(decision) || !isFilesystemAccess(access)) {
    throw policyError();
  }
  validateProjectPath(projectPath);
  const validatedPath = validatePolicyPath(path);
  const filesystem = filesystemPolicyForDocument(document);
  const scope = existingFilesystemScope(filesystem, projectPath, decision);
  if (filesystemScopeHasExactPath(scope, access, OPPOSITE_DECISION[decision], validatedPath)) {
    throw policyError();
  }
  if (filesystemScopeHasExactPath(scope, access, decision, validatedPath)) {
    return document;
  }
  const next = copyFilesystemPolicy(filesystem);
  const target = filesystemDecisionScope(next, projectPath, decision);
  appendFilesystemEntry(target, access, decision, validatedPath);
  return copyFilesystemIntoPolicyDocument(document, next);
}

function commandDecisionScope(
  policy: MutableCommandPolicy,
  projectPath: string,
  decision: PolicyDecision,
): MutableCommandScope {
  return decision.endsWith("global")
    ? policy.global
    : (policy.projects[projectPath] ?? (policy.projects[projectPath] = { allow: [], deny: [] }));
}

function existingCommandScope(
  policy: CommandPolicyData,
  projectPath: string,
  decision: PolicyDecision,
): CommandPolicyScope | undefined {
  return decision.endsWith("global") ? policy.global : policy.projects[projectPath];
}

function commandScopeContains(
  scope: CommandPolicyScope | undefined,
  decision: PolicyDecision,
  identity: CommandIdentity,
): boolean {
  const entries = decision.startsWith("allow") ? scope?.allow : scope?.deny;
  const key = commandIdentityKey(identity);
  return entries?.some((entry) => commandIdentityKey(entry) === key) ?? false;
}

function commandPolicyForDocument(document: PolicyDocument): CommandPolicyData {
  return document.version === 1 ? createEmptyCommandPolicy() : document.projectCommands;
}

export function applyProjectCommandPolicyDecision(
  document: PolicyDocument,
  projectPath: string,
  identity: CommandIdentity,
  decision: PolicyDecision,
  globalSafe: boolean,
): PolicyDocument {
  if (!isDecision(decision) || (decision === "allow-global" && !globalSafe)) {
    throw policyError();
  }
  validateProjectPath(projectPath);
  const validatedIdentity = validateCommandIdentity(identity);
  const policy = commandPolicyForDocument(document);
  const scope = existingCommandScope(policy, projectPath, decision);
  if (commandScopeContains(scope, OPPOSITE_DECISION[decision], validatedIdentity)) {
    throw policyError();
  }
  if (commandScopeContains(scope, decision, validatedIdentity)) {
    return document;
  }
  const next = copyCommandPolicy(policy);
  const target = commandDecisionScope(next, projectPath, decision);
  const entries = decision.startsWith("allow") ? target.allow : target.deny;
  entries.push({
    commandId: validatedIdentity.commandId,
    fingerprint: validatedIdentity.fingerprint,
  });
  return copyProjectCommandsIntoPolicyDocument(document, next);
}

export function findEnvironmentPolicyDecision(
  loaded: LoadedPolicy,
  key: string,
): PolicyAuthorization {
  validateProjectPath(loaded.projectPath);
  if (!isEnvironmentVariableName(key)) {
    throw policyError();
  }
  const policy = loaded.document.environment;
  if (policy.global.deny.includes(key)) {
    return "deny-global";
  }
  const project = policy.projects[loaded.projectPath];
  if (project?.deny.includes(key)) {
    return "deny-project";
  }
  if (policy.global.allow.includes(key)) {
    return "allow-global";
  }
  if (project?.allow.includes(key)) {
    return "allow-project";
  }
  return "unknown";
}

export function findProjectCommandPolicyDecision(
  loaded: LoadedPolicy,
  identity: CommandIdentity,
  globalSafe: boolean,
): PolicyAuthorization {
  validateProjectPath(loaded.projectPath);
  const validatedIdentity = validateCommandIdentity(identity);
  if (loaded.document.version === 1) {
    return "unknown";
  }
  const policy = loaded.document.projectCommands;
  const key = commandIdentityKey(validatedIdentity);
  if (policy.global.deny.some((entry) => commandIdentityKey(entry) === key)) {
    return "deny-global";
  }
  const project = policy.projects[loaded.projectPath];
  if (project?.deny.some((entry) => commandIdentityKey(entry) === key)) {
    return "deny-project";
  }
  if (globalSafe && policy.global.allow.some((entry) => commandIdentityKey(entry) === key)) {
    return "allow-global";
  }
  if (project?.allow.some((entry) => commandIdentityKey(entry) === key)) {
    return "allow-project";
  }
  return "unknown";
}

function findFilesystemPolicyDecisionInNamespace(
  loaded: LoadedPolicy,
  path: string,
  access: FilesystemAccess,
): PolicyAuthorization {
  if (loaded.document.version !== 4) {
    return "unknown";
  }
  const policy = loaded.document.filesystem;
  if (filesystemScopeContains(policy.global, access, "deny-global", path)) {
    return "deny-global";
  }
  const project = policy.projects[loaded.projectPath];
  if (filesystemScopeContains(project, access, "deny-project", path)) {
    return "deny-project";
  }
  if (filesystemScopeContains(policy.global, access, "allow-global", path)) {
    return "allow-global";
  }
  if (filesystemScopeContains(project, access, "allow-project", path)) {
    return "allow-project";
  }
  return "unknown";
}

export function findFilesystemPolicyDecision(
  loaded: LoadedPolicy,
  path: string,
  access: FilesystemAccess = "read",
): PolicyAuthorization {
  validateProjectPath(loaded.projectPath);
  if (!isFilesystemAccess(access)) {
    throw policyError();
  }
  const validatedPath = validatePolicyPath(path);
  const configuredDecision = findFilesystemPolicyDecisionInNamespace(loaded, validatedPath, access);
  if (configuredDecision !== "unknown") {
    return configuredDecision;
  }
  return (access === "read" || access === "write") &&
    isPathWithin(loaded.projectPath, validatedPath)
    ? "allow-project"
    : "unknown";
}
