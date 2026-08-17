import {
  assertPolicyAllowedKeys,
  isPolicyRecord,
  parseEnvironmentPolicy,
  policyError,
  serializePolicy,
  validateProjectPath,
} from "./format.ts";
import type { EnvironmentPolicyData } from "./types.ts";

const POLICY_DOCUMENT_VERSION = 2 as const;
const PROJECT_COMMAND_POLICY_VERSION = 1 as const;

export interface ProjectCommandIdentity {
  readonly commandId: string;
  readonly fingerprint: string;
}

export interface ProjectCommandPolicyScope {
  readonly allow: readonly ProjectCommandIdentity[];
  readonly deny: readonly ProjectCommandIdentity[];
}

export interface ProjectCommandPolicyData {
  readonly version: typeof PROJECT_COMMAND_POLICY_VERSION;
  readonly global: ProjectCommandPolicyScope;
  readonly projects: Readonly<Record<string, ProjectCommandPolicyScope>>;
}

export interface PolicyDocumentV2 {
  readonly version: typeof POLICY_DOCUMENT_VERSION;
  readonly environment: EnvironmentPolicyData;
  readonly projectCommands: ProjectCommandPolicyData;
}

export type PolicyDocument =
  | { readonly version: 1; readonly environment: EnvironmentPolicyData }
  | PolicyDocumentV2;

const PROJECT_COMMAND_ID_PATTERN = /^[a-z][a-z0-9_]*$/u;
const PROJECT_COMMAND_IDS = new Set(["workspace_path", "node_version"]);
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const DOCUMENT_KEYS = new Set(["version", "environment", "projectCommands"]);
const COMMAND_POLICY_KEYS = new Set(["version", "global", "projects"]);
const COMMAND_SCOPE_KEYS = new Set(["allow", "deny"]);
const DEFAULT_COMMAND_SCOPE: ProjectCommandPolicyScope = { allow: [], deny: [] };

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

function commandIdentityValues(value: Record<string, unknown>): {
  readonly commandId: string;
  readonly fingerprint: string;
} {
  const commandId = value.commandId;
  const fingerprint = value.fingerprint;
  if (
    typeof commandId !== "string" ||
    !PROJECT_COMMAND_ID_PATTERN.test(commandId) ||
    !PROJECT_COMMAND_IDS.has(commandId) ||
    typeof fingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(fingerprint)
  ) {
    throw policyError();
  }
  return { commandId, fingerprint };
}

function parseCommandIdentity(value: unknown): ProjectCommandIdentity {
  const record = commandIdentityRecord(value);
  validateCommandIdentityKeys(record);
  return commandIdentityValues(record);
}

function identityKey(identity: ProjectCommandIdentity): string {
  return `${identity.commandId}\u0000${identity.fingerprint}`;
}

function parseCommandIdentities(value: unknown): ProjectCommandIdentity[] {
  if (!Array.isArray(value)) {
    throw policyError();
  }
  const identities = value.map(parseCommandIdentity);
  if (new Set(identities.map(identityKey)).size !== identities.length) {
    throw policyError();
  }
  return identities;
}

function parseCommandScope(value: unknown): ProjectCommandPolicyScope {
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

function parseCommandProjects(value: unknown): Readonly<Record<string, ProjectCommandPolicyScope>> {
  if (!isPolicyRecord(value)) {
    throw policyError();
  }
  const projects: Record<string, ProjectCommandPolicyScope> = {};
  for (const [path, scope] of Object.entries(value)) {
    projects[validateProjectPath(path)] = parseCommandScope(scope);
  }
  return projects;
}

function parseProjectCommandPolicy(value: unknown): ProjectCommandPolicyData {
  if (!isPolicyRecord(value)) {
    throw policyError();
  }
  assertPolicyAllowedKeys(value, COMMAND_POLICY_KEYS);
  if (value.version !== PROJECT_COMMAND_POLICY_VERSION) {
    throw policyError();
  }
  const global =
    value.global === undefined ? DEFAULT_COMMAND_SCOPE : parseCommandScope(value.global);
  const projects = value.projects === undefined ? {} : parseCommandProjects(value.projects);
  return {
    version: PROJECT_COMMAND_POLICY_VERSION,
    global: { allow: [...global.allow], deny: [...global.deny] },
    projects,
  };
}

export function createEmptyProjectCommandPolicy(): ProjectCommandPolicyData {
  return {
    version: PROJECT_COMMAND_POLICY_VERSION,
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
  const projectCommands = parseProjectCommandPolicy(value.projectCommands);
  return { version: POLICY_DOCUMENT_VERSION, environment, projectCommands };
}

function serializeCommandIdentity(identity: ProjectCommandIdentity): ProjectCommandIdentity {
  return { commandId: identity.commandId, fingerprint: identity.fingerprint };
}

function serializeCommandScope(scope: ProjectCommandPolicyScope): ProjectCommandPolicyScope {
  const sort = (left: ProjectCommandIdentity, right: ProjectCommandIdentity): number =>
    identityKey(left).localeCompare(identityKey(right));
  return {
    allow: [...scope.allow].sort(sort).map(serializeCommandIdentity),
    deny: [...scope.deny].sort(sort).map(serializeCommandIdentity),
  };
}

function serializeCommandProjects(
  projects: Readonly<Record<string, ProjectCommandPolicyScope>>,
): Readonly<Record<string, ProjectCommandPolicyScope>> {
  const result: Record<string, ProjectCommandPolicyScope> = {};
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
      version: POLICY_DOCUMENT_VERSION,
      environment: document.environment,
      projectCommands: {
        version: PROJECT_COMMAND_POLICY_VERSION,
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
  projectCommands: ProjectCommandPolicyData,
): PolicyDocumentV2 {
  return {
    version: POLICY_DOCUMENT_VERSION,
    environment: document.environment,
    projectCommands,
  };
}

export function validateProjectCommandIdentity(
  identity: ProjectCommandIdentity,
): ProjectCommandIdentity {
  return parseCommandIdentity(identity);
}

export function commandIdentityKey(identity: ProjectCommandIdentity): string {
  return identityKey(identity);
}
