import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { applyEnvironmentPolicyDecision, applyProjectCommandPolicyDecision } from "./decisions.ts";
import { createNodePolicyFileSystem, type PolicyFileSystem } from "./filesystem.ts";
import {
  isEnvironmentVariableName,
  policyError,
  validatePolicyPath,
  validateProjectPath,
} from "./format.ts";
import { readPolicyDocument, withPolicyLock, writePolicyDocumentAtomically } from "./storage.ts";
import type {
  LoadedPolicy,
  PolicyDecisionRequest,
  PolicyStore,
  PolicyStoreTestOptions,
} from "./types.ts";

const POLICY_FILENAME = "bash-tools.json";
const defaultFileSystem: PolicyFileSystem = createNodePolicyFileSystem();

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw policyError();
  }
}

async function canonicalProjectPath(cwd: string, fileSystem: PolicyFileSystem): Promise<string> {
  return validateProjectPath(await fileSystem.realpath(cwd));
}

function validateRequest(request: PolicyDecisionRequest): void {
  if (request.kind === "environment") {
    if (!isEnvironmentVariableName(request.key)) {
      throw policyError();
    }
    return;
  }
  if (request.kind === "project-command") {
    return;
  }
  throw policyError();
}

interface LegacyEnvironmentRecord {
  recordDecision(
    projectPath: string,
    key: string,
    decision: import("./types.ts").PolicyDecision,
    signal?: AbortSignal,
  ): Promise<void>;
}

function createPolicyStoreWithFileSystem(
  configPath: string,
  fileSystem: PolicyFileSystem,
): PolicyStore & LegacyEnvironmentRecord {
  validatePolicyPath(configPath);
  const recordDecisions = async (
    projectPath: string,
    decisions: readonly PolicyDecisionRequest[],
    signal?: AbortSignal,
  ): Promise<void> => {
    throwIfAborted(signal);
    let canonicalPath: string;
    try {
      canonicalPath = await canonicalProjectPath(projectPath, fileSystem);
    } catch {
      throw policyError();
    }
    for (const request of decisions) {
      validateRequest(request);
    }
    await withPolicyLock(configPath, fileSystem, signal, async (parent) => {
      const document = await readPolicyDocument(configPath, fileSystem, parent);
      let next = document;
      for (const request of decisions) {
        next =
          request.kind === "environment"
            ? applyEnvironmentPolicyDecision(next, canonicalPath, request.key, request.decision)
            : applyProjectCommandPolicyDecision(
                next,
                canonicalPath,
                request.identity,
                request.decision,
                request.globalSafe,
              );
      }
      if (next !== document) {
        await writePolicyDocumentAtomically(configPath, next, fileSystem, parent, signal);
      }
    });
  };
  return {
    configPath,
    async load(cwd): Promise<LoadedPolicy> {
      let projectPath: string;
      try {
        projectPath = await canonicalProjectPath(cwd, fileSystem);
      } catch {
        throw policyError();
      }
      const document = await readPolicyDocument(configPath, fileSystem);
      return {
        projectPath,
        confirmationTimeoutMs: document.environment.confirmationTimeoutMs,
        document,
      };
    },
    recordDecisions,
    recordDecision: (projectPath, key, decision, signal) =>
      recordDecisions(projectPath, [{ kind: "environment", key, decision }], signal),
  };
}

export function createPolicyStore(): PolicyStore & LegacyEnvironmentRecord {
  return createPolicyStoreWithFileSystem(join(getAgentDir(), POLICY_FILENAME), defaultFileSystem);
}

export function createPolicyStoreForTesting(
  options: PolicyStoreTestOptions,
): PolicyStore & LegacyEnvironmentRecord {
  return createPolicyStoreWithFileSystem(options.configPath, {
    ...defaultFileSystem,
    ...options.fs,
  });
}
