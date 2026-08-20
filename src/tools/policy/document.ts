import {
  assertPolicyAllowedKeys,
  isPolicyRecord,
  parseEnvironmentPolicy,
  parseFilesystemPolicy,
  policyError,
  serializePolicy,
  validateProjectPath,
} from "./format.ts";
import {
  COMMAND_POLICY_VERSION,
  FILESYSTEM_POLICY_VERSION,
  type CommandIdentity,
  type CommandPolicyData,
  type CommandPolicyScope,
  type EnvironmentPolicyData,
  type FilesystemPolicyData,
  type FilesystemPolicyScope,
  type PolicyDocument,
} from "./types.ts";

const POLICY_DOCUMENT_VERSION = 3 as const;

const PROJECT_COMMAND_ID_PATTERN = /^[a-z][a-z0-9_]*$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const V2_DOCUMENT_KEYS = new Set(["version", "environment", "projectCommands"]);
const V3_DOCUMENT_KEYS = new Set(["version", "environment", "projectCommands", "filesystem"]);
const COMMAND_POLICY_KEYS = new Set(["version", "global", "projects"]);
const COMMAND_SCOPE_KEYS = new Set(["allow", "deny"]);
const DEFAULT_COMMAND_SCOPE: CommandPolicyScope = { allow: [], deny: [] };

function commandIdentityRecord(value: unknown): Record<string, unknown> {
  if (!isPolicyRecord(value)) {
    throw policyError();
  }
  return value;
}

function validateCommandIdentityKeys(value: Record<string, unknown>): void {
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("commandId") || !keys.includes("fingerprint")) {
    throw policyError();
  }
}

function commandIdentityValues(value: Record<string, unknown>): CommandIdentity {
  const commandId = value.commandId;
  const fingerprint = value.fingerprint;
  if (
    typeof commandId !== "string" ||
    !PROJECT_COMMAND_ID_PATTERN.test(commandId) ||
    typeof fingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(fingerprint)
  ) {
    throw policyError();
  }
  return { commandId, fingerprint };
}

function parseCommandIdentity(value: unknown): CommandIdentity {
  const record = commandIdentityRecord(value);
  validateCommandIdentityKeys(record);
  return commandIdentityValues(record);
}

function identityKey(identity: CommandIdentity): string {
  return `${identity.commandId}\u0000${identity.fingerprint}`;
}

function parseCommandIdentities(value: unknown): CommandIdentity[] {
  if (!Array.isArray(value)) {
    throw policyError();
  }
  const identities = value.map(parseCommandIdentity);
  if (new Set(identities.map(identityKey)).size !== identities.length) {
    throw policyError();
  }
  return identities;
}

function parseCommandScope(value: unknown): CommandPolicyScope {
  if (!isPolicyRecord(value)) {
    throw policyError();
  }
  assertPolicyAllowedKeys(value, COMMAND_SCOPE_KEYS);
  const allow = value.allow === undefined ? [] : parseCommandIdentities(value.allow);
  const deny = value.deny === undefined ? [] : parseCommandIdentities(value.deny);
  const denied = new Set(deny.map(identityKey));
  if (allow.some((identity) => denied.has(identityKey(identity)))) {
    throw policyError();
  }
  return { allow, deny };
}

function parseCommandProjects(value: unknown): Readonly<Record<string, CommandPolicyScope>> {
  if (!isPolicyRecord(value)) {
    throw policyError();
  }
  const projects: Record<string, CommandPolicyScope> = {};
  for (const [path, scope] of Object.entries(value)) {
    projects[validateProjectPath(path)] = parseCommandScope(scope);
  }
  return projects;
}

function parseCommandPolicy(value: unknown): CommandPolicyData {
  if (!isPolicyRecord(value)) {
    throw policyError();
  }
  assertPolicyAllowedKeys(value, COMMAND_POLICY_KEYS);
  if (value.version !== COMMAND_POLICY_VERSION) {
    throw policyError();
  }
  const global =
    value.global === undefined ? DEFAULT_COMMAND_SCOPE : parseCommandScope(value.global);
  const projects = value.projects === undefined ? {} : parseCommandProjects(value.projects);
  return {
    version: COMMAND_POLICY_VERSION,
    global: { allow: [...global.allow], deny: [...global.deny] },
    projects,
  };
}

export function createEmptyCommandPolicy(): CommandPolicyData {
  return {
    version: COMMAND_POLICY_VERSION,
    global: { allow: [], deny: [] },
    projects: {},
  };
}

export function parsePolicyDocument(text: string): PolicyDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw policyError();
  }
  if (!isPolicyRecord(value) || typeof value.version !== "number") {
    throw policyError();
  }
  if (value.version === 1) {
    return { version: 1, environment: parseEnvironmentPolicy(text) };
  }
  if (value.version !== 2 && value.version !== POLICY_DOCUMENT_VERSION) {
    throw policyError();
  }
  assertPolicyAllowedKeys(value, value.version === 2 ? V2_DOCUMENT_KEYS : V3_DOCUMENT_KEYS);
  if (!isPolicyRecord(value.environment)) {
    throw policyError();
  }
  const environment = parseEnvironmentPolicy(JSON.stringify(value.environment));
  const projectCommands = parseCommandPolicy(value.projectCommands);
  if (value.version === 2) {
    return { version: 2, environment, projectCommands };
  }
  const filesystem = parseFilesystemPolicy(value.filesystem);
  return { version: POLICY_DOCUMENT_VERSION, environment, projectCommands, filesystem };
}

function serializeCommandIdentity(identity: CommandIdentity): CommandIdentity {
  return { commandId: identity.commandId, fingerprint: identity.fingerprint };
}

function serializeCommandScope(scope: CommandPolicyScope): CommandPolicyScope {
  const sort = (left: CommandIdentity, right: CommandIdentity): number =>
    identityKey(left).localeCompare(identityKey(right));
  return {
    allow: [...scope.allow].sort(sort).map(serializeCommandIdentity),
    deny: [...scope.deny].sort(sort).map(serializeCommandIdentity),
  };
}

function serializeCommandProjects(
  projects: Readonly<Record<string, CommandPolicyScope>>,
): Readonly<Record<string, CommandPolicyScope>> {
  const result: Record<string, CommandPolicyScope> = {};
  for (const path of Object.keys(projects).sort()) {
    const scope = projects[path];
    if (scope !== undefined) {
      result[path] = serializeCommandScope(scope);
    }
  }
  return result;
}

function serializeFilesystemScope(scope: FilesystemPolicyScope): FilesystemPolicyScope {
  return {
    allow: [...scope.allow].sort(),
    deny: [...scope.deny].sort(),
  };
}

function serializeFilesystemProjects(
  projects: Readonly<Record<string, FilesystemPolicyScope>>,
): Readonly<Record<string, FilesystemPolicyScope>> {
  const result: Record<string, FilesystemPolicyScope> = {};
  for (const path of Object.keys(projects).sort()) {
    const scope = projects[path];
    if (scope !== undefined) {
      result[path] = serializeFilesystemScope(scope);
    }
  }
  return result;
}

function serializeProjectCommands(policy: CommandPolicyData): CommandPolicyData {
  return {
    version: COMMAND_POLICY_VERSION,
    global: serializeCommandScope(policy.global),
    projects: serializeCommandProjects(policy.projects),
  };
}

export function serializePolicyDocument(document: PolicyDocument): string {
  if (document.version === 1) {
    return serializePolicy(document.environment);
  }
  if (document.version === 2) {
    return `${JSON.stringify(
      {
        version: 2,
        environment: document.environment,
        projectCommands: serializeProjectCommands(document.projectCommands),
      },
      null,
      2,
    )}\n`;
  }
  return `${JSON.stringify(
    {
      version: POLICY_DOCUMENT_VERSION,
      environment: document.environment,
      projectCommands: serializeProjectCommands(document.projectCommands),
      filesystem: {
        version: FILESYSTEM_POLICY_VERSION,
        global: serializeFilesystemScope(document.filesystem.global),
        projects: serializeFilesystemProjects(document.filesystem.projects),
      },
    },
    null,
    2,
  )}\n`;
}

export function copyEnvironmentIntoPolicyDocument(
  document: PolicyDocument,
  environment: EnvironmentPolicyData,
): PolicyDocument {
  if (document.version === 1) {
    return { version: 1, environment };
  }
  if (document.version === 2) {
    return { version: 2, environment, projectCommands: document.projectCommands };
  }
  return {
    version: POLICY_DOCUMENT_VERSION,
    environment,
    projectCommands: document.projectCommands,
    filesystem: document.filesystem,
  };
}

export function copyProjectCommandsIntoPolicyDocument(
  document: PolicyDocument,
  projectCommands: CommandPolicyData,
): PolicyDocument {
  if (document.version === 1) {
    return {
      version: 2,
      environment: document.environment,
      projectCommands,
    };
  }
  if (document.version === 2) {
    return {
      version: 2,
      environment: document.environment,
      projectCommands,
    };
  }
  return {
    version: POLICY_DOCUMENT_VERSION,
    environment: document.environment,
    projectCommands,
    filesystem: document.filesystem,
  };
}

export function copyFilesystemIntoPolicyDocument(
  document: PolicyDocument,
  filesystem: FilesystemPolicyData,
): Extract<PolicyDocument, { version: 3 }> {
  return {
    version: POLICY_DOCUMENT_VERSION,
    environment: document.environment,
    projectCommands: document.version === 1 ? createEmptyCommandPolicy() : document.projectCommands,
    filesystem,
  };
}

export function validateCommandIdentity(identity: CommandIdentity): CommandIdentity {
  return parseCommandIdentity(identity);
}

export function commandIdentityKey(identity: CommandIdentity): string {
  return identityKey(identity);
}
