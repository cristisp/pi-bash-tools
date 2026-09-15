import type { ProjectCommandDiskJsonCache } from "../tools/project-command/cache.ts";
import { readProjectCommandOrchestrationContext } from "../tools/project-command/orchestration.ts";
import { isRecord } from "../tools/value-validation.ts";

export type FlowEvidenceRecordValidator<RecordT> = (
  value: unknown,
  scopeKey?: string,
) => value is RecordT;

export type FlowEvidenceDiskCacheFactory = (
  rootDirectory: string | undefined,
  validate: (value: unknown, logicalRequestKey?: string, scopeKey?: string) => boolean,
) => ProjectCommandDiskJsonCache;

export type FlowEvidenceLookupOutcome = "found" | "missing" | "corrupt";

export interface FlowEvidenceStoreOptions<RecordT extends { readonly ref: string }> {
  readonly refPattern: RegExp;
  readonly maxFlowRecords: number;
  readonly maxRootRecords?: number;
  readonly validate: FlowEvidenceRecordValidator<RecordT>;
  /** Tolerant read for legacy records; returned copies are read views and never persisted. */
  readonly normalize?: (value: unknown, scopeKey?: string) => RecordT | undefined;
  readonly createDiskCache: FlowEvidenceDiskCacheFactory;
}

export interface FlowEvidenceStoreCore<RecordT extends { readonly ref: string }> {
  readonly getByRef: (ref: string, flowId?: string) => RecordT | undefined;
  readonly lookupOutcome: (ref: string, flowId?: string) => FlowEvidenceLookupOutcome;
  readonly readFlowRecord: (flowId: string, ref: string) => RecordT | undefined;
  readonly readRootRecord: (ref: string) => RecordT | undefined;
  readonly writeRootRecord: (ref: string, record: RecordT) => void;
  readonly writeFlowRecord: (
    flowId: string,
    ref: string,
    record: RecordT,
    mode: "set" | "publish",
  ) => boolean;
  readonly clear: () => void;
}

/**
 * Shared in-memory tier for flow-scoped evidence stores on top of the project-command
 * disk cache. Publish gating stays per family; this layer only owns lookup and write
 * plumbing that is identical across families.
 */
export function createFlowEvidenceStore<RecordT extends { readonly ref: string }>(
  rootDirectory: string | undefined,
  options: FlowEvidenceStoreOptions<RecordT>,
): FlowEvidenceStoreCore<RecordT> {
  const { refPattern, validate } = options;
  const readRecord: (value: unknown, scopeKey?: string) => RecordT | undefined =
    options.normalize ??
    ((value: unknown, scopeKey?: string) => (validate(value, scopeKey) ? value : undefined));
  const maxRootRecords = options.maxRootRecords;
  const root = maxRootRecords === undefined ? undefined : new Map<string, RecordT>();
  const flows = new Map<string, Map<string, RecordT>>();
  const disk = options.createDiskCache(
    rootDirectory,
    (value, logicalRequestKey, scopeKey) =>
      logicalRequestKey !== undefined &&
      isRecord(value) &&
      value.ref === logicalRequestKey &&
      readRecord(value, scopeKey) !== undefined,
  );

  function trim(records: Map<string, RecordT>, maxRecords: number): void {
    while (records.size > maxRecords) {
      const oldest = records.keys().next().value;
      if (typeof oldest !== "string") return;
      records.delete(oldest);
    }
  }

  function writeFlow(
    flowId: string,
    ref: string,
    record: RecordT,
    mode: "set" | "publish",
  ): boolean {
    const persisted =
      mode === "set" ? disk.set(flowId, ref, record) : disk.publish(flowId, ref, record);
    if (!persisted) return false;
    const flow = flows.get(flowId) ?? new Map<string, RecordT>();
    flow.set(ref, record);
    trim(flow, options.maxFlowRecords);
    flows.set(flowId, flow);
    return true;
  }

  return {
    getByRef(ref, flowId) {
      if (!refPattern.test(ref)) return undefined;
      if (flowId === undefined) {
        if (root === undefined) return undefined;
        const value = root.get(ref);
        return value === undefined ? undefined : readRecord(value);
      }
      const inMemory = flows.get(flowId)?.get(ref);
      if (inMemory !== undefined) {
        const normalized = readRecord(inMemory, flowId);
        if (normalized !== undefined) return normalized;
      }
      return readProjectCommandOrchestrationContext().effectiveScope === "flow"
        ? readRecord(disk.get(flowId, ref), flowId)
        : undefined;
    },
    lookupOutcome(ref, flowId) {
      if (!refPattern.test(ref)) return "missing";
      if (flowId === undefined) {
        if (root === undefined) return "missing";
        const value = root.get(ref);
        if (value === undefined) return "missing";
        return readRecord(value) !== undefined ? "found" : "corrupt";
      }
      const inMemory = flows.get(flowId)?.get(ref);
      if (inMemory !== undefined) {
        return readRecord(inMemory, flowId) !== undefined ? "found" : "corrupt";
      }
      return "missing";
    },
    readFlowRecord: (flowId, ref) => flows.get(flowId)?.get(ref),
    readRootRecord: (ref) => root?.get(ref),
    writeRootRecord: (ref, record) => {
      if (root === undefined || maxRootRecords === undefined) return;
      root.set(ref, record);
      trim(root, maxRootRecords);
    },
    writeFlowRecord: (flowId, ref, record, mode) => writeFlow(flowId, ref, record, mode),
    clear() {
      root?.clear();
      flows.clear();
      disk.clear();
    },
  };
}
