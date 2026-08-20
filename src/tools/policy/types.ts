import type { PolicyFileSystem } from "./filesystem.ts";

export type { PolicyFileSystem } from "./filesystem.ts";

export const ENVIRONMENT_POLICY_VERSION = 1 as const;
export const COMMAND_POLICY_VERSION = 1 as const;
export const FILESYSTEM_POLICY_VERSION = 1 as const;

export interface EnvironmentPolicyScope {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

export interface EnvironmentPolicyData {
  readonly version: typeof ENVIRONMENT_POLICY_VERSION;
  readonly confirmationTimeoutMs: number;
  readonly global: EnvironmentPolicyScope;
  readonly projects: Readonly<Record<string, EnvironmentPolicyScope>>;
}

export interface CommandIdentity {
  readonly commandId: string;
  readonly fingerprint: string;
}

export interface CommandPolicyScope {
  readonly allow: readonly CommandIdentity[];
  readonly deny: readonly CommandIdentity[];
}

export interface CommandPolicyData {
  readonly version: typeof COMMAND_POLICY_VERSION;
  readonly global: CommandPolicyScope;
  readonly projects: Readonly<Record<string, CommandPolicyScope>>;
}

export interface FilesystemPolicyScope {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

export interface FilesystemPolicyData {
  readonly version: typeof FILESYSTEM_POLICY_VERSION;
  readonly global: FilesystemPolicyScope;
  readonly projects: Readonly<Record<string, FilesystemPolicyScope>>;
}

export type PolicyDocument =
  | { readonly version: 1; readonly environment: EnvironmentPolicyData }
  | {
      readonly version: 2;
      readonly environment: EnvironmentPolicyData;
      readonly projectCommands: CommandPolicyData;
    }
  | {
      readonly version: 3;
      readonly environment: EnvironmentPolicyData;
      readonly projectCommands: CommandPolicyData;
      readonly filesystem: FilesystemPolicyData;
    };

export interface LoadedPolicy {
  readonly projectPath: string;
  readonly confirmationTimeoutMs: number;
  readonly document: PolicyDocument;
}

export type PolicyDecision = "deny-global" | "deny-project" | "allow-global" | "allow-project";

export type PolicyAuthorization = PolicyDecision | "unknown";

export interface EnvironmentDecisionRequest {
  readonly kind: "environment";
  readonly key: string;
  readonly decision: PolicyDecision;
}

export interface ProjectCommandDecisionRequest {
  readonly kind: "project-command";
  readonly identity: CommandIdentity;
  readonly decision: PolicyDecision;
  readonly globalSafe: boolean;
}

export interface FilesystemDecisionRequest {
  readonly kind: "filesystem";
  readonly path: string;
  readonly decision: PolicyDecision;
}

export type PolicyDecisionRequest =
  | EnvironmentDecisionRequest
  | ProjectCommandDecisionRequest
  | FilesystemDecisionRequest;

export interface PolicyStore {
  readonly configPath: string;
  load(cwd: string): Promise<LoadedPolicy>;
  recordDecisions(
    projectPath: string,
    decisions: readonly PolicyDecisionRequest[],
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface PolicyStoreTestOptions {
  readonly configPath: string;
  readonly fs?: Partial<PolicyFileSystem>;
}
