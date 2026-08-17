import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { createNodePolicyFileSystem, type PolicyFileSystem } from "./policy/filesystem.ts";
import { applyEnvironmentPolicyDecision, withProjectPath } from "./policy/decisions.ts";
import {
  isEnvironmentVariableName,
  policyError,
  validatePolicyPath,
  validateProjectPath,
} from "./policy/format.ts";
import { readPolicyFile, withPolicyLock, writePolicyAtomically } from "./policy/storage.ts";
import type { EnvironmentPolicyStore, EnvironmentPolicyStoreTestOptions } from "./policy/types.ts";

export {
  DEFAULT_CONFIRMATION_TIMEOUT_MS,
  ENVIRONMENT_VARIABLE_NAME_PATTERN,
  parseEnvironmentPolicy,
} from "./policy/format.ts";
export { findEnvironmentPolicyDecision } from "./policy/decisions.ts";
export type {
  EnvironmentPolicyAuthorization,
  // fallow-ignore-next-line unused-type
  EnvironmentPolicyData,
  // fallow-ignore-next-line unused-type
  EnvironmentPolicyDecision,
  EnvironmentPolicyDecisionRequest,
  // fallow-ignore-next-line unused-type
  EnvironmentPolicyScope,
  EnvironmentPolicyStore,
  EnvironmentPolicyStoreTestOptions,
  LoadedEnvironmentPolicy,
  PolicyFileSystem,
} from "./policy/types.ts";

const ENVIRONMENT_POLICY_FILENAME = "bash-tools.json";
const defaultFileSystem: PolicyFileSystem = createNodePolicyFileSystem();

function throwIfPolicyOperationAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw policyError();
  }
}

function createPolicyStore(
  configPath: string,
  fileSystem: PolicyFileSystem,
): EnvironmentPolicyStore {
  validatePolicyPath(configPath);
  return {
    configPath,
    async load(cwd) {
      let projectPath: string;
      try {
        projectPath = await fileSystem.realpath(cwd);
      } catch {
        throw policyError();
      }
      validateProjectPath(projectPath);
      const policy = await readPolicyFile(configPath, fileSystem);
      return withProjectPath(policy, projectPath);
    },
    async recordDecision(projectPath, key, decision, signal) {
      await this.recordDecisions(projectPath, [{ key, decision }], signal);
    },
    async recordDecisions(projectPath, decisions, signal) {
      throwIfPolicyOperationAborted(signal);
      let canonicalProjectPath: string;
      try {
        canonicalProjectPath = await fileSystem.realpath(projectPath);
      } catch {
        throw policyError();
      }
      validateProjectPath(canonicalProjectPath);
      if (decisions.some(({ key }) => !isEnvironmentVariableName(key))) {
        throw policyError();
      }
      await withPolicyLock(configPath, fileSystem, signal, async (parent) => {
        const policy = await readPolicyFile(configPath, fileSystem, parent);
        let next = policy;
        for (const { key, decision } of decisions) {
          next = applyEnvironmentPolicyDecision(next, canonicalProjectPath, key, decision);
        }
        if (next !== policy) {
          await writePolicyAtomically(configPath, next, fileSystem, parent, signal);
        }
      });
    },
  };
}

export function createEnvironmentPolicyStore(): EnvironmentPolicyStore {
  return createPolicyStore(join(getAgentDir(), ENVIRONMENT_POLICY_FILENAME), defaultFileSystem);
}

export function createEnvironmentPolicyStoreForTesting(
  options: EnvironmentPolicyStoreTestOptions,
): EnvironmentPolicyStore {
  return createPolicyStore(options.configPath, { ...defaultFileSystem, ...options.fs });
}
