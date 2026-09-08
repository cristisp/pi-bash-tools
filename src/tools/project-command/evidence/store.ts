import type { ProjectCommandDiskJsonCache } from "../cache.ts";
import type {
  ProjectCommandEvidencePublication,
  ProjectCommandEvidenceRecord,
  ProjectCommandEvidenceStore,
  ProjectCommandEvidenceStoreOptions,
} from "../evidence.ts";
import {
  readProjectCommandOrchestrationContext,
  type ProjectCommandOrchestrationContext,
} from "../orchestration.ts";

const PROJECT_COMMAND_EVIDENCE_MAX_RECORDS = 256;
const PROJECT_COMMAND_EVIDENCE_REF_PATTERN = /^pc_[A-Za-z0-9_-]{8,128}$/u;

type EvidenceRecordValidator = (
  value: unknown,
  scopeKey?: string,
) => value is ProjectCommandEvidenceRecord;

type DiskCacheFactory = (
  rootDirectory: string | undefined,
  validate: (value: unknown, logicalRequestKey?: string, scopeKey?: string) => boolean,
) => ProjectCommandDiskJsonCache;

function trimEvidenceRecords(records: Map<string, ProjectCommandEvidenceRecord>): void {
  while (records.size > PROJECT_COMMAND_EVIDENCE_MAX_RECORDS) {
    const oldest = records.keys().next().value;
    if (typeof oldest !== "string") return;
    records.delete(oldest);
  }
}

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
  root: Map<string, ProjectCommandEvidenceRecord>,
  flows: Map<string, Map<string, ProjectCommandEvidenceRecord>>,
  ref: string,
  orchestration: ProjectCommandOrchestrationContext,
): ProjectCommandEvidenceRecord | undefined {
  if (orchestration.effectiveScope === "flow" && orchestration.flowId !== undefined) {
    return flows.get(orchestration.flowId)?.get(ref);
  }
  return root.get(ref);
}

function isPublishableEvidenceSource(
  source: ProjectCommandEvidenceRecord | undefined,
  flowId: string,
  repositoryIdentity: string | undefined,
  orchestration: ProjectCommandOrchestrationContext,
  isEvidenceRecord: EvidenceRecordValidator,
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

function writePublishedEvidence(
  disk: ProjectCommandDiskJsonCache,
  flows: Map<string, Map<string, ProjectCommandEvidenceRecord>>,
  flowId: string,
  ref: string,
  published: ProjectCommandEvidenceRecord,
): boolean {
  if (!disk.publish(flowId, ref, published)) return false;
  const flow = flows.get(flowId) ?? new Map<string, ProjectCommandEvidenceRecord>();
  flow.set(ref, published);
  trimEvidenceRecords(flow);
  flows.set(flowId, flow);
  return true;
}

export function createProjectCommandEvidenceStoreInternal(
  options: ProjectCommandEvidenceStoreOptions,
  isEvidenceRecord: EvidenceRecordValidator,
  createDiskCache: DiskCacheFactory,
): ProjectCommandEvidenceStore {
  const root = new Map<string, ProjectCommandEvidenceRecord>();
  const flows = new Map<string, Map<string, ProjectCommandEvidenceRecord>>();
  const disk = createDiskCache(
    options.rootDirectory,
    (value, logicalRequestKey, scopeKey) =>
      logicalRequestKey !== undefined &&
      isEvidenceRecord(value, scopeKey) &&
      value.ref === logicalRequestKey,
  );

  return {
    getByRef(ref, flowId) {
      if (!PROJECT_COMMAND_EVIDENCE_REF_PATTERN.test(ref)) return undefined;
      if (flowId === undefined) {
        const value = root.get(ref);
        return value !== undefined && isEvidenceRecord(value) ? value : undefined;
      }
      const inMemory = flows.get(flowId)?.get(ref);
      if (inMemory !== undefined && isEvidenceRecord(inMemory, flowId)) return inMemory;
      return readProjectCommandOrchestrationContext().effectiveScope === "flow"
        ? (() => {
            const value = disk.get(flowId, ref);
            return isEvidenceRecord(value, flowId) ? value : undefined;
          })()
        : undefined;
    },
    set(record, flowId) {
      if (!isEvidenceRecord(record, flowId)) return false;
      if (flowId === undefined) {
        root.set(record.ref, record);
        trimEvidenceRecords(root);
        return true;
      }
      if (!disk.set(flowId, record.ref, record)) return false;
      const flow = flows.get(flowId) ?? new Map<string, ProjectCommandEvidenceRecord>();
      flow.set(record.ref, record);
      trimEvidenceRecords(flow);
      flows.set(flowId, flow);
      return true;
    },
    publish(ref, flowId, repositoryIdentity, publication) {
      if (!hasValidPublicationScope(publication, flowId)) return false;
      const orchestration = readProjectCommandOrchestrationContext();
      if (!hasAuthorizedOrchestrationScope(orchestration, flowId)) return false;
      const source = findPublicationSource(root, flows, ref, orchestration);
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
      return writePublishedEvidence(disk, flows, flowId, ref, published);
    },
    clear() {
      root.clear();
      flows.clear();
      disk.clear();
    },
  };
}
