import type { PolicyFileSystem } from "./filesystem.ts";

export type {
  // fallow-ignore-next-line unused-type
  PolicyFileHandle,
  // fallow-ignore-next-line unused-type
  PolicyFileStats,
  PolicyFileSystem,
} from "./filesystem.ts";

export const ENVIRONMENT_POLICY_VERSION = 1 as const;

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

export interface LoadedEnvironmentPolicy extends EnvironmentPolicyData {
  readonly projectPath: string;
}

export type EnvironmentPolicyDecision =
  | "deny-global"
  | "deny-project"
  | "allow-global"
  | "allow-project";

export interface EnvironmentPolicyDecisionRequest {
  readonly key: string;
  readonly decision: EnvironmentPolicyDecision;
}

export type EnvironmentPolicyAuthorization = EnvironmentPolicyDecision | "unknown";

export interface EnvironmentPolicyStore {
  readonly configPath: string;
  load(cwd: string): Promise<LoadedEnvironmentPolicy>;
  recordDecision(
    projectPath: string,
    key: string,
    decision: EnvironmentPolicyDecision,
    signal?: AbortSignal,
  ): Promise<void>;
  recordDecisions(
    projectPath: string,
    decisions: readonly EnvironmentPolicyDecisionRequest[],
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface EnvironmentPolicyStoreTestOptions {
  readonly configPath: string;
  readonly fs?: Partial<PolicyFileSystem>;
}
