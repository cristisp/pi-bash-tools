import {
  ENVIRONMENT_POLICY_VERSION,
  type EnvironmentPolicyAuthorization,
  type EnvironmentPolicyData,
  type EnvironmentPolicyDecision,
  type EnvironmentPolicyScope,
} from "./types.ts";
import { isEnvironmentVariableName, policyError, validateProjectPath } from "./format.ts";

interface MutablePolicyScope {
  allow: string[];
  deny: string[];
}

type MutableEnvironmentPolicy = {
  version: typeof ENVIRONMENT_POLICY_VERSION;
  confirmationTimeoutMs: number;
  global: MutablePolicyScope;
  projects: Record<string, MutablePolicyScope>;
};

function copyScope(scope: EnvironmentPolicyScope | undefined): MutablePolicyScope {
  return scope === undefined
    ? { allow: [], deny: [] }
    : { allow: [...scope.allow], deny: [...scope.deny] };
}

function copyEnvironmentPolicy(policy: EnvironmentPolicyData): MutableEnvironmentPolicy {
  const projects: Record<string, MutablePolicyScope> = {};
  for (const [path, scope] of Object.entries(policy.projects)) {
    projects[path] = copyScope(scope);
  }
  return {
    version: ENVIRONMENT_POLICY_VERSION,
    confirmationTimeoutMs: policy.confirmationTimeoutMs,
    global: copyScope(policy.global),
    projects,
  };
}

function isPolicyDecision(value: string): value is EnvironmentPolicyDecision {
  return (
    value === "deny-global" ||
    value === "deny-project" ||
    value === "allow-global" ||
    value === "allow-project"
  );
}

const OPPOSITE_DECISION: Record<EnvironmentPolicyDecision, EnvironmentPolicyDecision> = {
  "deny-global": "allow-global",
  "deny-project": "allow-project",
  "allow-global": "deny-global",
  "allow-project": "deny-project",
};

function decisionScope(
  policy: MutableEnvironmentPolicy,
  projectPath: string,
  decision: EnvironmentPolicyDecision,
): MutablePolicyScope {
  return decision.endsWith("global")
    ? policy.global
    : (policy.projects[projectPath] ?? (policy.projects[projectPath] = copyScope(undefined)));
}

function existingDecisionScope(
  policy: EnvironmentPolicyData,
  projectPath: string,
  decision: EnvironmentPolicyDecision,
): EnvironmentPolicyScope | undefined {
  return decision.endsWith("global") ? policy.global : policy.projects[projectPath];
}

function scopeContains(
  scope: EnvironmentPolicyScope | undefined,
  decision: EnvironmentPolicyDecision,
  key: string,
): boolean {
  const list = decision.startsWith("allow") ? scope?.allow : scope?.deny;
  return list?.includes(key) ?? false;
}

export function applyEnvironmentPolicyDecision(
  policy: EnvironmentPolicyData,
  projectPath: string,
  key: string,
  decision: EnvironmentPolicyDecision,
): EnvironmentPolicyData {
  if (!isPolicyDecision(decision)) {
    throw policyError();
  }
  validateProjectPath(projectPath);
  if (!isEnvironmentVariableName(key)) {
    throw policyError();
  }

  const scope = existingDecisionScope(policy, projectPath, decision);
  if (scopeContains(scope, OPPOSITE_DECISION[decision], key)) {
    throw policyError();
  }
  if (scopeContains(scope, decision, key)) {
    return policy;
  }

  const next = copyEnvironmentPolicy(policy);
  const target = decisionScope(next, projectPath, decision);
  const list = decision.startsWith("allow") ? target.allow : target.deny;
  list.push(key);
  return next;
}

export function withProjectPath(
  policy: EnvironmentPolicyData,
  projectPath: string,
): EnvironmentPolicyData & { readonly projectPath: string } {
  return { ...policy, projectPath };
}

export function findEnvironmentPolicyDecision(
  policy: EnvironmentPolicyData,
  projectPath: string,
  key: string,
): EnvironmentPolicyAuthorization {
  validateProjectPath(projectPath);
  if (!isEnvironmentVariableName(key)) {
    throw policyError();
  }
  if (policy.global.deny.includes(key)) {
    return "deny-global";
  }
  const project = policy.projects[projectPath];
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
