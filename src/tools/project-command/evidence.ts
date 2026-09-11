import {
  aggregateSharedEvidenceOutput,
  EVIDENCE_PRODUCER,
  mapEvidenceScope,
  sharedEvidenceRequestHash,
  sharedWorkspaceBlock,
  type SharedEvidenceKind,
  type SharedEvidenceOutputBlock,
  type SharedEvidenceWorkspaceBlock,
} from "../../evidence/envelope.ts";
import { createProjectCommandDiskJsonCache } from "./cache.ts";
import { isEvidenceRecord, safeEvidenceKey } from "./evidence/record-validation.ts";
export { isEvidenceRecord };
import { createProjectCommandEvidenceStoreInternal } from "./evidence/store.ts";
import type { ProjectCommandOutputDetails } from "./output.ts";
import type { ProjectCommandRepositoryState } from "./repository-state.ts";

const PROJECT_COMMAND_EVIDENCE_FORMAT_VERSION = 1 as const;

export interface ProjectCommandEvidenceProvenance {
  readonly scope: "session" | "flow";
  readonly flowId?: string;
  readonly producerInvocationId?: string;
  readonly producerSessionId?: string;
  readonly producerRole?: string;
  readonly producerDelegationId?: string;
}

export interface ProjectCommandEvidencePublication {
  readonly scope: "root" | "flow";
  readonly flowId?: string;
  readonly published: boolean;
  readonly error?: string;
}

export interface ProjectCommandEvidenceRecord {
  readonly evidenceFormatVersion: typeof PROJECT_COMMAND_EVIDENCE_FORMAT_VERSION;
  readonly key: string;
  readonly ref: string;
  readonly details: ProjectCommandOutputDetails;
  readonly repositoryState?: ProjectCommandRepositoryState;
  readonly covers: readonly string[];
  readonly createdAt: number;
  readonly producer?: typeof EVIDENCE_PRODUCER;
  readonly kind?: SharedEvidenceKind;
  readonly scope?: "session" | "flow";
  readonly requestHash?: string;
  readonly contentHash?: string;
  readonly workspace?: SharedEvidenceWorkspaceBlock;
  readonly output?: SharedEvidenceOutputBlock;
  readonly producerScope?: "session" | "flow";
  readonly flowId?: string;
  readonly producerRole?: string;
  readonly producerDelegationId?: string;
  readonly provenance?: ProjectCommandEvidenceProvenance;
  readonly publication?: ProjectCommandEvidencePublication;
}

export interface ProjectCommandEvidenceStore {
  getByRef(ref: string, flowId?: string): ProjectCommandEvidenceRecord | undefined;
  set(record: ProjectCommandEvidenceRecord, flowId?: string): boolean;
  publish(
    ref: string,
    flowId: string,
    repositoryIdentity?: string,
    publication?: ProjectCommandEvidencePublication,
  ): boolean;
  clear(): void;
}

export interface ProjectCommandEvidenceStoreOptions {
  readonly rootDirectory?: string;
}

const safeKey = safeEvidenceKey;

function projectCommandEvidenceDigest(
  details: Pick<
    ProjectCommandOutputDetails,
    "commandId" | "projectPath" | "parameters" | "status" | "category" | "stdout" | "stderr"
  >,
): string {
  return safeKey({
    commandId: details.commandId,
    projectPath: details.projectPath,
    parameters: details.parameters,
    status: details.status,
    category: details.category,
    stdout: details.stdout,
    stderr: details.stderr,
  });
}

export function createProjectCommandEvidenceRecord(
  details: ProjectCommandOutputDetails,
  options: Omit<
    Partial<ProjectCommandEvidenceRecord>,
    | "evidenceFormatVersion"
    | "key"
    | "ref"
    | "details"
    | "createdAt"
    | "producer"
    | "kind"
    | "scope"
    | "requestHash"
    | "contentHash"
    | "workspace"
    | "output"
  > & { readonly repositoryState?: ProjectCommandRepositoryState },
): ProjectCommandEvidenceRecord {
  const digest = projectCommandEvidenceDigest(details);
  const ref = `pc_${digest.slice(0, 24)}`;
  return Object.freeze({
    evidenceFormatVersion: PROJECT_COMMAND_EVIDENCE_FORMAT_VERSION,
    key: safeKey({ ref, details }),
    ref,
    producer: EVIDENCE_PRODUCER,
    kind: "project-command" as const,
    scope: mapEvidenceScope(options.producerScope ?? "session"),
    requestHash: sharedEvidenceRequestHash({
      commandId: details.commandId,
      projectPath: details.projectPath,
      parameters: details.parameters,
    }),
    contentHash: digest,
    ...(options.repositoryState === undefined
      ? {}
      : { workspace: sharedWorkspaceBlock(options.repositoryState) }),
    output: aggregateSharedEvidenceOutput([details.output.stdout, details.output.stderr]),
    details: Object.freeze({ ...details, ref }),
    ...(options.repositoryState === undefined ? {} : { repositoryState: options.repositoryState }),
    covers: Object.freeze([...(options.covers ?? [])].slice(0, 64)),
    createdAt: Date.now(),
    ...(options.producerScope === undefined ? {} : { producerScope: options.producerScope }),
    ...(options.flowId === undefined ? {} : { flowId: options.flowId }),
    ...(options.producerRole === undefined ? {} : { producerRole: options.producerRole }),
    ...(options.producerDelegationId === undefined
      ? {}
      : { producerDelegationId: options.producerDelegationId }),
    ...(options.provenance === undefined ? {} : { provenance: options.provenance }),
    ...(options.publication === undefined ? {} : { publication: options.publication }),
  });
}

export function createProjectCommandEvidenceStore(
  options: ProjectCommandEvidenceStoreOptions = {},
): ProjectCommandEvidenceStore {
  return createProjectCommandEvidenceStoreInternal(
    options,
    isEvidenceRecord,
    (rootDirectory, validate) =>
      createProjectCommandDiskJsonCache(
        rootDirectory === undefined ? {} : { rootDirectory },
        validate,
      ),
  );
}
