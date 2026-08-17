import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
  applyProjectCommandPolicyDecision,
  type ProjectCommandPolicyDecision,
  type ProjectCommandPolicyDecisionRequest,
} from "./policy-decisions.ts";
import {
  createEmptyProjectCommandPolicy,
  readProjectCommandPolicy,
  type ProjectCommandIdentity,
  type ProjectCommandPolicyData,
} from "./policy-format.ts";
import {
  type PolicyDocument,
  type ProjectCommandPolicyScope,
  copyProjectCommandsIntoPolicyDocument,
  createEmptyProjectCommandPolicy as createEmptyDocumentProjectCommandPolicy,
  validateProjectCommandIdentity,
} from "../environment/policy/document.ts";
import {
  createNodePolicyFileSystem,
  type PolicyFileSystem,
} from "../environment/policy/filesystem.ts";
import { withPolicyLock, writePolicyDocumentAtomically } from "../environment/policy/storage.ts";
import {
  policyError,
  validatePolicyPath,
  validateProjectPath,
} from "../environment/policy/format.ts";

const POLICY_FILENAME = "bash-tools.json";
const defaultFileSystem: PolicyFileSystem = createNodePolicyFileSystem();

export interface LoadedProjectCommandPolicy {
  readonly projectPath: string;
  readonly confirmationTimeoutMs: number;
  readonly global: ProjectCommandPolicyScope;
  readonly project: ProjectCommandPolicyScope;
}

export interface ProjectCommandPolicyStore {
  readonly configPath: string;
  load(cwd: string): Promise<LoadedProjectCommandPolicy>;
  recordDecision(
    projectPath: string,
    identity: ProjectCommandIdentity,
    decision: ProjectCommandPolicyDecision,
    signal?: AbortSignal,
    globalSafe?: boolean,
  ): Promise<void>;
  recordDecisions(
    projectPath: string,
    decisions: readonly ProjectCommandPolicyDecisionRequest[],
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface ProjectCommandPolicyStoreTestOptions {
  readonly configPath: string;
  readonly fs?: Partial<PolicyFileSystem>;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw policyError();
  }
}

function canonicalProjectPath(cwd: string, fileSystem: PolicyFileSystem): Promise<string> {
  return fileSystem.realpath(cwd).then((path) => validateProjectPath(path));
}

function emptyScope(): ProjectCommandPolicyScope {
  return { allow: [], deny: [] };
}

function loadedPolicy(document: PolicyDocument, projectPath: string): LoadedProjectCommandPolicy {
  const commands =
    document.version === 2 ? document.projectCommands : createEmptyDocumentProjectCommandPolicy();
  return {
    projectPath,
    confirmationTimeoutMs: document.environment.confirmationTimeoutMs,
    global: commands.global,
    project: commands.projects[projectPath] ?? emptyScope(),
  };
}

function toCommandPolicyData(policy: ProjectCommandPolicyData): ProjectCommandPolicyData {
  return {
    version: 1,
    global: { allow: [...policy.global.allow], deny: [...policy.global.deny] },
    projects: Object.fromEntries(
      Object.entries(policy.projects).map(([path, scope]) => [
        path,
        {
          allow: [...scope.allow],
          deny: [...scope.deny],
        },
      ]),
    ),
  };
}

function commandPolicyFromDocument(document: PolicyDocument): ProjectCommandPolicyData {
  return document.version === 2
    ? toCommandPolicyData(document.projectCommands)
    : createEmptyProjectCommandPolicy();
}

function documentWithCommands(
  document: PolicyDocument,
  projectCommands: ProjectCommandPolicyData,
): PolicyDocument {
  return copyProjectCommandsIntoPolicyDocument(document, projectCommands);
}

function ensureDecisionIdentity(identity: ProjectCommandIdentity): ProjectCommandIdentity {
  return validateProjectCommandIdentity(identity);
}

export function createProjectCommandPolicyStore(): ProjectCommandPolicyStore {
  return createProjectCommandPolicyStoreWithFileSystem(join(getAgentDir(), POLICY_FILENAME), {});
}

export function createProjectCommandPolicyStoreForTesting(
  options: ProjectCommandPolicyStoreTestOptions,
): ProjectCommandPolicyStore {
  return createProjectCommandPolicyStoreWithFileSystem(options.configPath, options.fs ?? {});
}

function createProjectCommandPolicyStoreWithFileSystem(
  configPath: string,
  overrides: Partial<PolicyFileSystem>,
): ProjectCommandPolicyStore {
  validatePolicyPath(configPath);
  const fileSystem = { ...defaultFileSystem, ...overrides };
  return {
    configPath,
    async load(cwd) {
      let projectPath: string;
      try {
        projectPath = await canonicalProjectPath(cwd, fileSystem);
      } catch {
        throw policyError();
      }
      const document = await readProjectCommandPolicy(configPath, fileSystem);
      return loadedPolicy(document, projectPath);
    },
    async recordDecision(projectPath, identity, decision, signal, globalSafe = false) {
      await this.recordDecisions(projectPath, [{ identity, decision, globalSafe }], signal);
    },
    async recordDecisions(projectPath, decisions, signal) {
      throwIfAborted(signal);
      let canonicalPath: string;
      try {
        canonicalPath = await canonicalProjectPath(projectPath, fileSystem);
      } catch {
        throw policyError();
      }
      const validated = decisions.map((request) => ({
        ...request,
        identity: ensureDecisionIdentity(request.identity),
      }));
      await withPolicyLock(configPath, fileSystem, signal, async (parent) => {
        const document = await readProjectCommandPolicy(configPath, fileSystem, parent);
        let next = commandPolicyFromDocument(document);
        for (const request of validated) {
          next = applyProjectCommandPolicyDecision(
            next,
            canonicalPath,
            request.identity,
            request.decision,
            request.globalSafe,
          );
        }
        if (document.version !== 2 || next !== document.projectCommands) {
          await writePolicyDocumentAtomically(
            configPath,
            documentWithCommands(document, next),
            fileSystem,
            parent,
            signal,
          );
        }
      });
    },
  };
}
