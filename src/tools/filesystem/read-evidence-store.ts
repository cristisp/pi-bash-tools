import {
  aggregateSharedEvidenceOutput,
  EVIDENCE_PRODUCER,
  sharedEvidenceContentHash,
  sharedEvidenceRequestHash,
  type SharedEvidenceOutputBlock,
  type SharedEvidenceWorkspaceBlock,
} from "../../evidence/envelope.ts";
import {
  createFlowEvidenceStore,
  type FlowEvidenceDiskCacheFactory,
  type FlowEvidenceRecordValidator,
} from "../../evidence/flow-store.ts";
import { createProjectCommandDiskJsonCache } from "../project-command/cache.ts";
import { readProjectCommandOrchestrationContext } from "../project-command/orchestration.ts";
import { FLOW_ID_PATTERN } from "../value-validation.ts";
import {
  isReadEvidenceRecord,
  READ_EVIDENCE_REF_PATTERN,
  readEvidenceRecordRef,
} from "./read-evidence-validation.ts";

const READ_EVIDENCE_FORMAT_VERSION = 1 as const;

const MAX_PUBLISHED_READ_EVIDENCE_ENTRIES = 128;

export interface ReadEvidenceRange {
  readonly offset?: number;
  readonly limit?: number;
}

export interface ReadEvidenceEntry {
  readonly path: string;
  readonly range?: ReadEvidenceRange;
  readonly contentHash: string;
  readonly content: string;
  readonly output: SharedEvidenceOutputBlock;
}

interface ReadEvidenceProvenance {
  readonly scope: "flow";
  readonly flowId: string;
}

export interface ReadEvidenceRecord {
  readonly evidenceFormatVersion: typeof READ_EVIDENCE_FORMAT_VERSION;
  readonly ref: string;
  readonly producer: typeof EVIDENCE_PRODUCER;
  readonly kind: "read-batch";
  readonly scope: "flow";
  readonly requestHash: string;
  readonly contentHash: string;
  readonly workspace?: SharedEvidenceWorkspaceBlock;
  readonly output?: SharedEvidenceOutputBlock;
  readonly provenance: ReadEvidenceProvenance;
  readonly entries: readonly ReadEvidenceEntry[];
}

export interface ReadEvidenceStore {
  getByRef(ref: string, flowId?: string): ReadEvidenceRecord | undefined;
  /** Classification for telemetry only; durable records are never probed for corruption. */
  lookupOutcome?(ref: string, flowId?: string): "found" | "missing" | "corrupt";
  publish(record: ReadEvidenceRecord, flowId: string): boolean;
  clear(): void;
}

interface ReadEvidenceStoreOptions {
  readonly rootDirectory?: string;
}

export function createPublishedReadEvidenceRecord(options: {
  readonly root: string;
  readonly flowId: string;
  readonly entries: readonly ReadEvidenceEntry[];
  readonly workspace?: SharedEvidenceWorkspaceBlock;
}): ReadEvidenceRecord {
  const contentHash = sharedEvidenceContentHash(
    options.entries.map((entry) => ({
      path: entry.path,
      range: entry.range ?? null,
      contentHash: entry.contentHash,
    })),
  );
  return Object.freeze({
    evidenceFormatVersion: READ_EVIDENCE_FORMAT_VERSION,
    ref: readEvidenceRecordRef(contentHash),
    producer: EVIDENCE_PRODUCER,
    kind: "read-batch" as const,
    scope: "flow" as const,
    requestHash: sharedEvidenceRequestHash({
      root: options.root,
      entries: options.entries.map((entry) => ({
        path: entry.path,
        range: entry.range ?? null,
      })),
    }),
    contentHash,
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    output: aggregateSharedEvidenceOutput(options.entries.map((entry) => entry.output)),
    provenance: Object.freeze({ scope: "flow" as const, flowId: options.flowId }),
    entries: Object.freeze(options.entries.map((entry) => Object.freeze({ ...entry }))),
  });
}

export function createReadEvidenceStoreInternal(
  options: ReadEvidenceStoreOptions,
  isEvidenceRecord: FlowEvidenceRecordValidator<ReadEvidenceRecord>,
  createDiskCache: FlowEvidenceDiskCacheFactory,
): ReadEvidenceStore {
  const core = createFlowEvidenceStore<ReadEvidenceRecord>(options.rootDirectory, {
    refPattern: READ_EVIDENCE_REF_PATTERN,
    maxFlowRecords: MAX_PUBLISHED_READ_EVIDENCE_ENTRIES,
    validate: isEvidenceRecord,
    createDiskCache,
  });

  return {
    getByRef: core.getByRef,
    lookupOutcome: core.lookupOutcome,
    publish(record, flowId) {
      if (!FLOW_ID_PATTERN.test(flowId)) return false;
      if (!isEvidenceRecord(record, flowId)) return false;
      if (record.provenance.flowId !== flowId) return false;
      const orchestration = readProjectCommandOrchestrationContext();
      if (orchestration.effectiveScope !== "flow" || orchestration.flowId !== flowId) return false;
      return core.writeFlowRecord(flowId, record.ref, record, "publish");
    },
    clear: core.clear,
  };
}

export function createReadEvidenceStore(options: ReadEvidenceStoreOptions = {}): ReadEvidenceStore {
  return createReadEvidenceStoreInternal(options, isReadEvidenceRecord, (rootDirectory, validate) =>
    createProjectCommandDiskJsonCache(
      rootDirectory === undefined ? {} : { rootDirectory },
      validate,
    ),
  );
}
