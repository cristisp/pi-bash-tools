import {
  createProjectCommandDiskJsonCache,
  type ProjectCommandDiskJsonCache,
} from "../project-command/cache.ts";
import { readProjectCommandOrchestrationContext } from "../project-command/orchestration.ts";
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

function unwrapRequest(
  value: unknown,
  logicalRequestKey: string,
): VerifyEvidenceRecord | undefined {
  return isVerifyEvidenceRecord(value, logicalRequestKey) ? value : undefined;
}

function unwrapRef(value: unknown, ref: string): VerifyEvidenceRecord | undefined {
  const logicalRequestKey = `ref:${ref}`;
  return isVerifyRefAlias(value, logicalRequestKey) ? value.record : undefined;
}

export { isVerifyEvidenceCacheRecord, isVerifyEvidenceRecord } from "./cache/validation.ts";

export function createVerifyEvidenceCache(
  options: VerifyEvidenceCacheOptions = {},
): VerifyEvidenceCache {
  const local = new Map<string, VerifyEvidenceRecord>();
  const disk = createDiskCache(options);
  const byRef = new Map<string, VerifyEvidenceRecord>();
  return {
    get(key) {
      const orchestration = readProjectCommandOrchestrationContext();
      if (orchestration.effectiveScope === "flow" && orchestration.flowId !== undefined) {
        return unwrapRequest(disk.get(orchestration.flowId, key), key);
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
      if (orchestration.effectiveScope === "flow" && orchestration.flowId !== undefined) {
        return unwrapRef(disk.get(orchestration.flowId, `ref:${ref}`), ref);
      }
      return byRef.get(ref);
    },
    set(record) {
      const orchestration = readProjectCommandOrchestrationContext();
      if (orchestration.effectiveScope === "flow" && orchestration.flowId !== undefined) {
        disk.set(orchestration.flowId, record.key, record);
        disk.set(orchestration.flowId, `ref:${record.ref}`, {
          key: `ref:${record.ref}`,
          record,
        });
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
      const firstWrite = disk.publish(flowId, published.key, published);
      const secondWrite = disk.publish(flowId, `ref:${published.ref}`, {
        key: `ref:${published.ref}`,
        record: published,
      });
      return firstWrite && secondWrite ? published : undefined;
    },
  };
}
