import {
  ENVIRONMENT_POLICY_VERSION,
  type EnvironmentPolicyData,
  type EnvironmentPolicyScope,
} from "../types.ts";
import { defaultConfirmationTimeoutMs } from "./constants.ts";
import {
  assertPolicyAllowedKeysInternal,
  isPolicyRecordInternal,
  policyErrorInternal,
} from "./errors.ts";
import { isEnvironmentVariableNameInternal, validateProjectPathInternal } from "./validation.ts";

const ROOT_KEYS = new Set(["version", "confirmationTimeoutMs", "global", "projects"]);
const SCOPE_KEYS = new Set(["allow", "deny"]);
const DEFAULT_SCOPE: EnvironmentPolicyScope = { allow: [], deny: [] };

function parseEnvironmentVariableNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw policyErrorInternal();
  }
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isEnvironmentVariableNameInternal(item)) {
      throw policyErrorInternal();
    }
    names.push(item);
  }
  if (new Set(names).size !== names.length) {
    throw policyErrorInternal();
  }
  return names;
}

function parseScope(value: unknown): EnvironmentPolicyScope {
  if (!isPolicyRecordInternal(value)) {
    throw policyErrorInternal();
  }
  assertPolicyAllowedKeysInternal(value, SCOPE_KEYS);
  const allow = value.allow === undefined ? [] : parseEnvironmentVariableNames(value.allow);
  const deny = value.deny === undefined ? [] : parseEnvironmentVariableNames(value.deny);
  if (allow.some((name) => deny.includes(name))) {
    throw policyErrorInternal();
  }
  return { allow, deny };
}

function parseProjects(value: unknown): Readonly<Record<string, EnvironmentPolicyScope>> {
  if (!isPolicyRecordInternal(value)) {
    throw policyErrorInternal();
  }
  const projects: Record<string, EnvironmentPolicyScope> = {};
  for (const [path, scope] of Object.entries(value)) {
    projects[validateProjectPathInternal(path)] = parseScope(scope);
  }
  return projects;
}

export function createEmptyEnvironmentPolicyInternal(): EnvironmentPolicyData {
  return {
    version: ENVIRONMENT_POLICY_VERSION,
    confirmationTimeoutMs: defaultConfirmationTimeoutMs,
    global: { ...DEFAULT_SCOPE },
    projects: {},
  };
}

export function parseEnvironmentPolicyInternal(text: string): EnvironmentPolicyData {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw policyErrorInternal();
  }
  if (!isPolicyRecordInternal(value)) {
    throw policyErrorInternal();
  }
  assertPolicyAllowedKeysInternal(value, ROOT_KEYS);
  if (value.version !== ENVIRONMENT_POLICY_VERSION) {
    throw policyErrorInternal();
  }
  const timeout: unknown = value.confirmationTimeoutMs;
  if (
    timeout !== undefined &&
    (typeof timeout !== "number" ||
      !Number.isSafeInteger(timeout) ||
      timeout < 0 ||
      timeout > 2_147_483_647)
  ) {
    throw policyErrorInternal();
  }
  const global = value.global === undefined ? { ...DEFAULT_SCOPE } : parseScope(value.global);
  const projects = value.projects === undefined ? {} : parseProjects(value.projects);
  return {
    version: ENVIRONMENT_POLICY_VERSION,
    confirmationTimeoutMs: typeof timeout === "number" ? timeout : defaultConfirmationTimeoutMs,
    global,
    projects,
  };
}

export function serializePolicyInternal(policy: EnvironmentPolicyData): string {
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
