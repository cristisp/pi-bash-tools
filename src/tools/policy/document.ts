import {
  assertPolicyAllowedKeys,
  isPolicyRecord,
  parseEnvironmentPolicy,
  policyError,
  serializePolicy,
  validateProjectPath,
} from "./format.ts";
import {
  COMMAND_POLICY_VERSION,
  type CommandIdentity,
  type CommandPolicyData,
  type CommandPolicyScope,
  type EnvironmentPolicyData,
  type PolicyDocument,
} from "./types.ts";

const POLICY_DOCUMENT_VERSION = 2 as const;

const PROJECT_COMMAND_ID_PATTERN = /^[a-z][a-z0-9_]*$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const DOCUMENT_KEYS = new Set(["version", "environment", "projectCommands"]);
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
  assertPolicyAllowedKeys(value, DOCUMENT_KEYS);
  if (value.version !== POLICY_DOCUMENT_VERSION || !isPolicyRecord(value.environment)) {
    throw policyError();
  }
  const environment = parseEnvironmentPolicy(JSON.stringify(value.environment));
  const projectCommands = parseCommandPolicy(value.projectCommands);
  return { version: POLICY_DOCUMENT_VERSION, environment, projectCommands };
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

export function serializePolicyDocument(document: PolicyDocument): string {
  if (document.version === 1) {
    return serializePolicy(document.environment);
  }
  return `${JSON.stringify(
    {
      version: 2,
      environment: document.environment,
      projectCommands: {
        version: COMMAND_POLICY_VERSION,
        global: serializeCommandScope(document.projectCommands.global),
        projects: serializeCommandProjects(document.projectCommands.projects),
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
  return document.version === 1
    ? { version: 1, environment }
    : { version: POLICY_DOCUMENT_VERSION, environment, projectCommands: document.projectCommands };
}

export function copyProjectCommandsIntoPolicyDocument(
  document: PolicyDocument,
  projectCommands: CommandPolicyData,
): Extract<PolicyDocument, { version: 2 }> {
  return {
    version: POLICY_DOCUMENT_VERSION,
    environment: document.environment,
    projectCommands,
  };
}

export function validateCommandIdentity(identity: CommandIdentity): CommandIdentity {
  return parseCommandIdentity(identity);
}

export function commandIdentityKey(identity: CommandIdentity): string {
  return identityKey(identity);
}
