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

function isPublishableEvidenceSource(
  source: ProjectCommandEvidenceRecord | undefined,
  flowId: string,
  repositoryIdentity: string | undefined,
  orchestration: ProjectCommandOrchestrationContext,
  isEvidenceRecord: FlowEvidenceRecordValidator<ProjectCommandEvidenceRecord>,
): source is ProjectCommandEvidenceRecord {
  const scopeKey = orchestration.effectiveScope === "flow" ? flowId : undefined;
  if (source === undefined || !isEvidenceRecord(source, scopeKey)) return false;
  if (source.provenance?.scope === "flow" && source.provenance.flowId !== flowId) return false;
  return (
    repositoryIdentity !== undefined &&
    source.repositoryState?.repositoryIdentity === repositoryIdentity
  );
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
    producerScope: "flow" as const,
    flowId,
    provenance: {
      ...(source.provenance ?? { scope: "session" as const }),
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
): ProjectCommandEvidenceStore {
  const core = createFlowEvidenceStore<ProjectCommandEvidenceRecord>(options.rootDirectory, {
    refPattern: PROJECT_COMMAND_EVIDENCE_REF_PATTERN,
    maxFlowRecords: PROJECT_COMMAND_EVIDENCE_MAX_RECORDS,
    maxRootRecords: PROJECT_COMMAND_EVIDENCE_MAX_RECORDS,
    validate: isEvidenceRecord,
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
      if (
        !isPublishableEvidenceSource(
          source,
          flowId,
          repositoryIdentity,
          orchestration,
          isEvidenceRecord,
        )
      ) {
        return false;
      }
      const published = createPublishedEvidenceRecord(source, flowId, publication);
      if (!isEvidenceRecord(published, flowId)) return false;
      return core.writeFlowRecord(flowId, ref, published, "publish");
    },
    clear: core.clear,
  };
}
