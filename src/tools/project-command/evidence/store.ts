import {
  createFlowEvidenceStore,
  type FlowEvidenceDiskCacheFactory,
  type FlowEvidenceRecordValidator,
  type FlowEvidenceStoreCore,
} from "../../../evidence/flow-store.ts";
import type {
  ProjectCommandEvidencePublication,
  ProjectCommandEvidenceRecord,
  ProjectCommandEvidenceStore,
  ProjectCommandEvidenceStoreOptions,
} from "../evidence.ts";
import {
  effectiveOrchestrationFlowId,
  readProjectCommandOrchestrationContext,
  type ProjectCommandOrchestrationContext,
} from "../orchestration.ts";

type FlowEvidenceRecordNormalizer = (
  value: unknown,
  scopeKey?: string,
) => ProjectCommandEvidenceRecord | undefined;

const PROJECT_COMMAND_EVIDENCE_MAX_RECORDS = 256;
const PROJECT_COMMAND_EVIDENCE_REF_PATTERN = /^pc_[A-Za-z0-9_-]{8,128}$/u;

function hasValidPublicationScope(
  publication: ProjectCommandEvidencePublication | undefined,
  flowId: string,
): boolean {
  return publication?.scope === "flow" && publication.flowId === flowId && publication.published;
}

function hasAuthorizedOrchestrationScope(
  orchestration: ProjectCommandOrchestrationContext,
  flowId: string,
): boolean {
  return orchestration.effectiveScope !== "flow" || orchestration.flowId === flowId;
}

function findPublicationSource(
  core: FlowEvidenceStoreCore<ProjectCommandEvidenceRecord>,
  ref: string,
  orchestration: ProjectCommandOrchestrationContext,
): ProjectCommandEvidenceRecord | undefined {
  const flowId = effectiveOrchestrationFlowId(orchestration);
  if (flowId !== undefined) {
    return core.readFlowRecord(flowId, ref);
  }
  return core.readRootRecord(ref);
}

function publishableEvidenceSource(
  source: ProjectCommandEvidenceRecord | undefined,
  flowId: string,
  repositoryIdentity: string | undefined,
  orchestration: ProjectCommandOrchestrationContext,
  normalize: FlowEvidenceRecordNormalizer,
): ProjectCommandEvidenceRecord | undefined {
  const scopeKey = orchestration.effectiveScope === "flow" ? flowId : undefined;
  const candidate = source === undefined ? undefined : normalize(source, scopeKey);
  if (candidate === undefined) return undefined;
  if (candidate.provenance.scope === "flow" && candidate.provenance.flowId !== flowId) {
    return undefined;
  }
  if (
    repositoryIdentity === undefined ||
    candidate.repositoryState?.repositoryIdentity !== repositoryIdentity
  ) {
    return undefined;
  }
  return candidate;
}

function createPublishedEvidenceRecord(
  source: ProjectCommandEvidenceRecord,
  flowId: string,
  publication: ProjectCommandEvidencePublication | undefined,
): ProjectCommandEvidenceRecord {
  const publishedMetadata =
    publication ??
    ({
      scope: "flow",
      flowId,
      published: true,
    } satisfies ProjectCommandEvidencePublication);
  return Object.freeze({
    ...source,
    details: Object.freeze({ ...source.details, publication: publishedMetadata }),
    provenance: {
      ...source.provenance,
      scope: "flow" as const,
      flowId,
    },
    publication: publishedMetadata,
  });
}

export function createProjectCommandEvidenceStoreInternal(
  options: ProjectCommandEvidenceStoreOptions,
  isEvidenceRecord: FlowEvidenceRecordValidator<ProjectCommandEvidenceRecord>,
  createDiskCache: FlowEvidenceDiskCacheFactory,
  normalize: FlowEvidenceRecordNormalizer = (value, scopeKey) =>
    isEvidenceRecord(value, scopeKey) ? value : undefined,
): ProjectCommandEvidenceStore {
  const core = createFlowEvidenceStore<ProjectCommandEvidenceRecord>(options.rootDirectory, {
    refPattern: PROJECT_COMMAND_EVIDENCE_REF_PATTERN,
    maxFlowRecords: PROJECT_COMMAND_EVIDENCE_MAX_RECORDS,
    maxRootRecords: PROJECT_COMMAND_EVIDENCE_MAX_RECORDS,
    validate: isEvidenceRecord,
    normalize,
    createDiskCache,
  });

  return {
    getByRef: core.getByRef,
    lookupOutcome: core.lookupOutcome,
    set(record, flowId) {
      if (!isEvidenceRecord(record, flowId)) return false;
      if (flowId === undefined) {
        core.writeRootRecord(record.ref, record);
        return true;
      }
      return core.writeFlowRecord(flowId, record.ref, record, "set");
    },
    publish(ref, flowId, repositoryIdentity, publication) {
      if (!hasValidPublicationScope(publication, flowId)) return false;
      const orchestration = readProjectCommandOrchestrationContext();
      if (!hasAuthorizedOrchestrationScope(orchestration, flowId)) return false;
      const source = findPublicationSource(core, ref, orchestration);
      const candidate = publishableEvidenceSource(
        source,
        flowId,
        repositoryIdentity,
        orchestration,
        normalize,
      );
      if (candidate === undefined) return false;
      const published = createPublishedEvidenceRecord(candidate, flowId, publication);
      if (!isEvidenceRecord(published, flowId)) return false;
      return core.writeFlowRecord(flowId, ref, published, "publish");
    },
    clear: core.clear,
  };
}
