import {
  aggregateSharedEvidenceOutput,
  EVIDENCE_PRODUCER,
  sharedEvidenceContentHash,
  sharedEvidenceRequestHash,
  type SharedEvidenceOutputBlock,
  type SharedEvidenceWorkspaceBlock,
} from "../../evidence/envelope.ts";
import {
  createProjectCommandDiskJsonCache,
  type ProjectCommandDiskJsonCache,
} from "../project-command/cache.ts";
import { readProjectCommandOrchestrationContext } from "../project-command/orchestration.ts";
import {
  isReadEvidenceRecord,
  READ_EVIDENCE_REF_PATTERN,
  READ_EVIDENCE_REF_PREFIX,
  readEvidenceRecordRef,
} from "./read-evidence-validation.ts";

export { READ_EVIDENCE_REF_PREFIX, readEvidenceRecordRef };

export const READ_EVIDENCE_FORMAT_VERSION = 1 as const;
export const MAX_PUBLISHED_READ_EVIDENCE_ENTRIES = 128;

const READ_EVIDENCE_FLOW_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

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

export interface ReadEvidenceProvenance {
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

export interface ReadEvidenceStoreOptions {
  readonly rootDirectory?: string;
}

type ReadEvidenceRecordValidator = (
  value: unknown,
  scopeKey?: string,
) => value is ReadEvidenceRecord;

type DiskCacheFactory = (
  rootDirectory: string | undefined,
  validate: (value: unknown, logicalRequestKey?: string, scopeKey?: string) => boolean,
) => ProjectCommandDiskJsonCache;

function trimEvidenceRecords(records: Map<string, ReadEvidenceRecord>): void {
  while (records.size > MAX_PUBLISHED_READ_EVIDENCE_ENTRIES) {
    const oldest = records.keys().next().value;
    if (typeof oldest !== "string") return;
    records.delete(oldest);
  }
}

function classifyEvidenceRecord(
  value: ReadEvidenceRecord | undefined,
  isEvidenceRecord: ReadEvidenceRecordValidator,
): "found" | "missing" | "corrupt" {
  if (value === undefined) return "missing";
  return isEvidenceRecord(value) ? "found" : "corrupt";
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
  isEvidenceRecord: ReadEvidenceRecordValidator,
  createDiskCache: DiskCacheFactory,
): ReadEvidenceStore {
  const root = new Map<string, ReadEvidenceRecord>();
  const flows = new Map<string, Map<string, ReadEvidenceRecord>>();
  const disk = createDiskCache(
    options.rootDirectory,
    (value, logicalRequestKey, scopeKey) =>
      logicalRequestKey !== undefined &&
      isEvidenceRecord(value, scopeKey) &&
      value.ref === logicalRequestKey,
  );

  return {
    getByRef(ref, flowId) {
      if (!READ_EVIDENCE_REF_PATTERN.test(ref)) return undefined;
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
    lookupOutcome(ref, flowId) {
      if (!READ_EVIDENCE_REF_PATTERN.test(ref)) return "missing";
      if (flowId === undefined) {
        return classifyEvidenceRecord(root.get(ref), isEvidenceRecord);
      }
      const inMemory = flows.get(flowId)?.get(ref);
      if (inMemory !== undefined) {
        return isEvidenceRecord(inMemory, flowId) ? "found" : "corrupt";
      }
      return "missing";
    },
    publish(record, flowId) {
      if (!READ_EVIDENCE_FLOW_ID_PATTERN.test(flowId)) return false;
      if (!isEvidenceRecord(record, flowId)) return false;
      if (record.provenance.flowId !== flowId) return false;
      const orchestration = readProjectCommandOrchestrationContext();
      if (orchestration.effectiveScope !== "flow" || orchestration.flowId !== flowId) return false;
      if (!disk.publish(flowId, record.ref, record)) return false;
      const flow = flows.get(flowId) ?? new Map<string, ReadEvidenceRecord>();
      flow.set(record.ref, record);
      trimEvidenceRecords(flow);
      flows.set(flowId, flow);
      return true;
    },
    clear() {
      root.clear();
      flows.clear();
      disk.clear();
    },
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
