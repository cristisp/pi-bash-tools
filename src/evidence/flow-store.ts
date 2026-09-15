import type { ProjectCommandDiskJsonCache } from "../tools/project-command/cache.ts";
import { readProjectCommandOrchestrationContext } from "../tools/project-command/orchestration.ts";

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
  const maxRootRecords = options.maxRootRecords;
  const root = maxRootRecords === undefined ? undefined : new Map<string, RecordT>();
  const flows = new Map<string, Map<string, RecordT>>();
  const disk = options.createDiskCache(
    rootDirectory,
    (value, logicalRequestKey, scopeKey) =>
      logicalRequestKey !== undefined &&
      validate(value, scopeKey) &&
      value.ref === logicalRequestKey,
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
        return value !== undefined && validate(value) ? value : undefined;
      }
      const inMemory = flows.get(flowId)?.get(ref);
      if (inMemory !== undefined && validate(inMemory, flowId)) return inMemory;
      return readProjectCommandOrchestrationContext().effectiveScope === "flow"
        ? (() => {
            const value = disk.get(flowId, ref);
            return validate(value, flowId) ? value : undefined;
          })()
        : undefined;
    },
    lookupOutcome(ref, flowId) {
      if (!refPattern.test(ref)) return "missing";
      if (flowId === undefined) {
        if (root === undefined) return "missing";
        const value = root.get(ref);
        if (value === undefined) return "missing";
        return validate(value) ? "found" : "corrupt";
      }
      const inMemory = flows.get(flowId)?.get(ref);
      if (inMemory !== undefined) return validate(inMemory, flowId) ? "found" : "corrupt";
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
