import {
  createProjectCommandDiskJsonCache,
  type ProjectCommandDiskJsonCache,
} from "../project-command/cache.ts";
import {
  effectiveOrchestrationFlowId,
  readProjectCommandOrchestrationContext,
} from "../project-command/orchestration.ts";
import {
  isVerifyEvidenceCacheRecord,
  isVerifyEvidenceRecord,
  isVerifyRefAlias,
} from "./cache/validation.ts";
import { type VerifyEvidenceRecord } from "./types.ts";

const VERIFY_LOCAL_MAX_RECORDS = 64;

export interface VerifyEvidenceCacheOptions {
  readonly rootDirectory?: string;
}

export interface VerifyEvidenceCache {
  get(key: string): VerifyEvidenceRecord | undefined;
  getByRef(ref: string, flowId?: string): VerifyEvidenceRecord | undefined;
  set(record: VerifyEvidenceRecord): void;
  publish?(
    ref: string,
    flowId: string,
    repositoryIdentity: string,
  ): VerifyEvidenceRecord | undefined;
}

function createDiskCache(options: VerifyEvidenceCacheOptions): ProjectCommandDiskJsonCache {
  return createProjectCommandDiskJsonCache(
    options.rootDirectory === undefined ? {} : { rootDirectory: options.rootDirectory },
    (value, logicalRequestKey) =>
      logicalRequestKey !== undefined && isVerifyEvidenceCacheRecord(value, logicalRequestKey),
  );
}

function unwrapRequest(value: unknown, key: string): VerifyEvidenceRecord | undefined {
  return isVerifyEvidenceRecord(value) && value.key === key ? value : undefined;
}

function unwrapRef(value: unknown, ref: string): VerifyEvidenceRecord | undefined {
  if (isVerifyEvidenceRecord(value) && value.ref === ref) return value;
  return isVerifyRefAlias(value, `ref:${ref}`) ? value.record : undefined;
}

export { isVerifyEvidenceCacheRecord, isVerifyEvidenceRecord } from "./cache/validation.ts";

function requestRef(key: string): string {
  return `vr_${key.slice(0, 24)}`;
}

export function createVerifyEvidenceCache(
  options: VerifyEvidenceCacheOptions = {},
): VerifyEvidenceCache {
  const local = new Map<string, VerifyEvidenceRecord>();
  const disk = createDiskCache(options);
  const byRef = new Map<string, VerifyEvidenceRecord>();
  return {
    get(key) {
      const orchestration = readProjectCommandOrchestrationContext();
      const flowId = effectiveOrchestrationFlowId(orchestration);
      if (flowId !== undefined) {
        return unwrapRequest(disk.get(flowId, `ref:${requestRef(key)}`), key);
      }
      return local.get(key);
    },
    getByRef(ref, requestedFlowId) {
      const orchestration = readProjectCommandOrchestrationContext();
      if (requestedFlowId !== undefined) {
        if (orchestration.effectiveScope !== "flow" || orchestration.flowId !== requestedFlowId) {
          return undefined;
        }
        return unwrapRef(disk.get(requestedFlowId, `ref:${ref}`), ref);
      }
      const flowId = effectiveOrchestrationFlowId(orchestration);
      if (flowId !== undefined) {
        return unwrapRef(disk.get(flowId, `ref:${ref}`), ref);
      }
      return byRef.get(ref);
    },
    set(record) {
      const orchestration = readProjectCommandOrchestrationContext();
      const flowId = effectiveOrchestrationFlowId(orchestration);
      if (flowId !== undefined) {
        disk.set(flowId, `ref:${record.ref}`, record);
        return;
      }
      const previous = local.get(record.key);
      if (previous !== undefined) byRef.delete(previous.ref);
      while (local.size >= VERIFY_LOCAL_MAX_RECORDS && !local.has(record.key)) {
        const oldestKey = local.keys().next().value;
        if (oldestKey === undefined) break;
        const oldest = local.get(oldestKey);
        local.delete(oldestKey);
        if (oldest !== undefined) byRef.delete(oldest.ref);
      }
      local.set(record.key, record);
      byRef.set(record.ref, record);
    },
    publish(ref, flowId, repositoryIdentity) {
      const orchestration = readProjectCommandOrchestrationContext();
      if (orchestration.effectiveScope === "flow" && orchestration.flowId !== flowId) {
        return undefined;
      }
      const source =
        orchestration.effectiveScope === "flow" && orchestration.flowId !== undefined
          ? unwrapRef(disk.get(orchestration.flowId, `ref:${ref}`), ref)
          : byRef.get(ref);
      if (
        source === undefined ||
        (source.provenance?.scope === "flow" && source.provenance.flowId !== flowId) ||
        source.repositoryState?.repositoryIdentity !== repositoryIdentity
      ) {
        return undefined;
      }
      const published: VerifyEvidenceRecord = {
        ...source,
        provenance: {
          scope: "flow",
          flowId,
          repositoryIdentity,
        },
        publication: {
          flowId,
          repositoryIdentity,
          producerScope: source.provenance?.scope ?? "root",
          published: true,
        },
      };
      const firstWrite = disk.publish(flowId, `ref:${published.ref}`, published);
      return firstWrite ? published : undefined;
    },
  };
}
