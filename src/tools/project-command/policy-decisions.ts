import {
  commandIdentityKey,
  type ProjectCommandIdentity,
  type ProjectCommandPolicyData,
  validateProjectCommandIdentity,
} from "../environment/policy/document.ts";
import { policyError, validateProjectPath } from "../environment/policy/format.ts";

export type ProjectCommandPolicyDecision =
  | "deny-global"
  | "deny-project"
  | "allow-global"
  | "allow-project";

export type ProjectCommandPolicyAuthorization = ProjectCommandPolicyDecision | "unknown";

export interface ProjectCommandPolicyDecisionRequest {
  readonly identity: ProjectCommandIdentity;
  readonly decision: ProjectCommandPolicyDecision;
  readonly globalSafe: boolean;
}

interface MutableScope {
  allow: ProjectCommandIdentity[];
  deny: ProjectCommandIdentity[];
}

interface MutablePolicy {
  version: 1;
  global: MutableScope;
  projects: Record<string, MutableScope>;
}

function copyScope(
  scope:
    | {
        readonly allow: readonly ProjectCommandIdentity[];
        readonly deny: readonly ProjectCommandIdentity[];
      }
    | undefined,
): MutableScope {
  return scope === undefined
    ? { allow: [], deny: [] }
    : { allow: [...scope.allow], deny: [...scope.deny] };
}

function copyPolicy(policy: ProjectCommandPolicyData): MutablePolicy {
  return {
    version: 1,
    global: copyScope(policy.global),
    projects: Object.fromEntries(
      Object.entries(policy.projects).map(([path, scope]) => [path, copyScope(scope)]),
    ),
  };
}

function isDecision(value: string): value is ProjectCommandPolicyDecision {
  return (
    value === "deny-global" ||
    value === "deny-project" ||
    value === "allow-global" ||
    value === "allow-project"
  );
}

function targetScope(
  policy: MutablePolicy,
  projectPath: string,
  decision: ProjectCommandPolicyDecision,
): MutableScope {
  return decision.endsWith("global")
    ? policy.global
    : (policy.projects[projectPath] ?? (policy.projects[projectPath] = { allow: [], deny: [] }));
}

function sourceScope(
  policy: ProjectCommandPolicyData,
  projectPath: string,
  decision: ProjectCommandPolicyDecision,
):
  | {
      readonly allow: readonly ProjectCommandIdentity[];
      readonly deny: readonly ProjectCommandIdentity[];
    }
  | undefined {
  return decision.endsWith("global") ? policy.global : policy.projects[projectPath];
}

function contains(
  scope:
    | {
        readonly allow: readonly ProjectCommandIdentity[];
        readonly deny: readonly ProjectCommandIdentity[];
      }
    | undefined,
  decision: ProjectCommandPolicyDecision,
  identity: ProjectCommandIdentity,
): boolean {
  const entries = decision.startsWith("allow") ? scope?.allow : scope?.deny;
  const key = commandIdentityKey(identity);
  return entries?.some((entry) => commandIdentityKey(entry) === key) ?? false;
}

function opposite(decision: ProjectCommandPolicyDecision): ProjectCommandPolicyDecision {
  return decision.startsWith("allow")
    ? decision.endsWith("global")
      ? "deny-global"
      : "deny-project"
    : decision.endsWith("global")
      ? "allow-global"
      : "allow-project";
}

export function applyProjectCommandPolicyDecision(
  policy: ProjectCommandPolicyData,
  projectPath: string,
  identity: ProjectCommandIdentity,
  decision: ProjectCommandPolicyDecision,
  globalSafe: boolean,
): ProjectCommandPolicyData {
  if (!isDecision(decision) || (decision === "allow-global" && !globalSafe)) {
    throw policyError();
  }
  validateProjectPath(projectPath);
  validateProjectCommandIdentity(identity);
  const source = sourceScope(policy, projectPath, decision);
  if (contains(source, opposite(decision), identity)) {
    throw policyError();
  }
  if (contains(source, decision, identity)) {
    return policy;
  }
  const next = copyPolicy(policy);
  const target = targetScope(next, projectPath, decision);
  const entries = decision.startsWith("allow") ? target.allow : target.deny;
  entries.push({ commandId: identity.commandId, fingerprint: identity.fingerprint });
  return next;
}

export function findProjectCommandPolicyDecision(
  policy: ProjectCommandPolicyData,
  projectPath: string,
  identity: ProjectCommandIdentity,
  globalSafe: boolean,
): ProjectCommandPolicyAuthorization {
  validateProjectPath(projectPath);
  validateProjectCommandIdentity(identity);
  const key = commandIdentityKey(identity);
  if (policy.global.deny.some((entry) => commandIdentityKey(entry) === key)) {
    return "deny-global";
  }
  const project = policy.projects[projectPath];
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
