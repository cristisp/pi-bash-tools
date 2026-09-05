import { hashCanonicalJson } from "../../observability/canonical-json.ts";
import { createProjectCommandDiskJsonCache, type ProjectCommandDiskJsonCache } from "./cache.ts";
import type { ProjectCommandOutputDetails } from "./output.ts";
import type { ProjectCommandRepositoryState } from "./repository-state.ts";
import { readProjectCommandOrchestrationContext } from "./orchestration.ts";

export const PROJECT_COMMAND_EVIDENCE_FORMAT_VERSION = 1 as const;
export const PROJECT_COMMAND_EVIDENCE_REF_PATTERN = /^pc_[A-Za-z0-9_-]{8,128}$/u;

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
  readonly producerScope?: "session" | "flow";
  readonly flowId?: string;
  readonly producerRole?: string;
  readonly producerDelegationId?: string;
  readonly provenance?: ProjectCommandEvidenceProvenance;
  readonly publication?: ProjectCommandEvidencePublication;
}

export interface ProjectCommandEvidenceStore {
  getByRef(ref: string, flowId?: string): ProjectCommandEvidenceRecord | undefined;
  set(record: ProjectCommandEvidenceRecord, flowId?: string): void;
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

function safeKey(value: unknown): string {
  try {
    return hashCanonicalJson(value);
  } catch {
    return hashCanonicalJson({ type: typeof value });
  }
}

export function projectCommandEvidenceRef(
  details: Pick<
    ProjectCommandOutputDetails,
    "commandId" | "projectPath" | "parameters" | "status" | "category" | "stdout" | "stderr"
  >,
): string {
  return `pc_${safeKey({
    commandId: details.commandId,
    projectPath: details.projectPath,
    parameters: details.parameters,
    status: details.status,
    category: details.category,
    stdout: details.stdout,
    stderr: details.stderr,
  }).slice(0, 24)}`;
}

export function createProjectCommandEvidenceRecord(
  details: ProjectCommandOutputDetails,
  options: Omit<
    Partial<ProjectCommandEvidenceRecord>,
    "evidenceFormatVersion" | "key" | "ref" | "details" | "createdAt"
  > & { readonly repositoryState?: ProjectCommandRepositoryState },
): ProjectCommandEvidenceRecord {
  const ref = projectCommandEvidenceRef(details);
  return Object.freeze({
    evidenceFormatVersion: PROJECT_COMMAND_EVIDENCE_FORMAT_VERSION,
    key: safeKey({ ref, details }),
    ref,
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

const PROJECT_COMMAND_EVIDENCE_MAX_RECORDS = 256;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isEvidenceDetails(value: unknown, ref: string): value is ProjectCommandOutputDetails {
  if (!isRecord(value) || value.ref !== ref) return false;
  const scope = value.scope;
  return (
    isBoundedString(value.commandId, 128) &&
    isRecord(scope) &&
    isBoundedString(scope.projectPath, 4096) &&
    isBoundedString(value.fingerprint, 256) &&
    isBoundedString(value.authFingerprint, 256) &&
    isBoundedString(value.toolCallId, 256) &&
    typeof value.reused === "boolean" &&
    typeof value.forced === "boolean" &&
    typeof value.executed === "boolean" &&
    typeof value.durationMs === "number" &&
    Number.isFinite(value.durationMs) &&
    typeof value.executionDurationMs === "number" &&
    Number.isFinite(value.executionDurationMs)
  );
}

function isEvidenceRecord(
  value: unknown,
  scopeKey?: string,
): value is ProjectCommandEvidenceRecord {
  if (!isRecord(value)) return false;
  const record = value;
  return (
    record.evidenceFormatVersion === PROJECT_COMMAND_EVIDENCE_FORMAT_VERSION &&
    typeof record.key === "string" &&
    typeof record.ref === "string" &&
    PROJECT_COMMAND_EVIDENCE_REF_PATTERN.test(record.ref) &&
    isEvidenceDetails(record.details, record.ref) &&
    (scopeKey === undefined ||
      (isRecord(record.provenance) &&
        record.provenance.scope === "flow" &&
        record.provenance.flowId === scopeKey)) &&
    Array.isArray(record.covers) &&
    record.covers.length <= 64 &&
    record.covers.every((cover) => typeof cover === "string" && cover.length <= 512) &&
    typeof record.createdAt === "number" &&
    Number.isFinite(record.createdAt)
  );
}

export function createProjectCommandEvidenceStore(
  options: ProjectCommandEvidenceStoreOptions = {},
): ProjectCommandEvidenceStore {
  const root = new Map<string, ProjectCommandEvidenceRecord>();
  const flows = new Map<string, Map<string, ProjectCommandEvidenceRecord>>();
  const disk: ProjectCommandDiskJsonCache = createProjectCommandDiskJsonCache(
    options.rootDirectory === undefined ? {} : { rootDirectory: options.rootDirectory },
    (value, logicalRequestKey, scopeKey) =>
      logicalRequestKey !== undefined &&
      isEvidenceRecord(value, scopeKey) &&
      value.ref === logicalRequestKey,
  );

  const trim = (records: Map<string, ProjectCommandEvidenceRecord>): void => {
    while (records.size > PROJECT_COMMAND_EVIDENCE_MAX_RECORDS) {
      const oldest = records.keys().next().value;
      if (typeof oldest !== "string") return;
      records.delete(oldest);
    }
  };
  return {
    getByRef(ref, flowId) {
      if (!PROJECT_COMMAND_EVIDENCE_REF_PATTERN.test(ref)) return undefined;
      if (flowId === undefined) return root.get(ref);
      return (
        flows.get(flowId)?.get(ref) ??
        (readProjectCommandOrchestrationContext().effectiveScope === "flow"
          ? (() => {
              const value = disk.get(flowId, ref);
              return isEvidenceRecord(value) ? value : undefined;
            })()
          : undefined)
      );
    },
    set(record, flowId) {
      if (flowId === undefined) {
        root.set(record.ref, record);
        trim(root);
      } else {
        const flow = flows.get(flowId) ?? new Map<string, ProjectCommandEvidenceRecord>();
        flow.set(record.ref, record);
        trim(flow);
        flows.set(flowId, flow);
        disk.set(flowId, record.ref, record);
      }
    },
    publish(ref, flowId, repositoryIdentity, publication) {
      const orchestration = readProjectCommandOrchestrationContext();
      if (orchestration.effectiveScope === "flow" && orchestration.flowId !== flowId) {
        return false;
      }
      const source =
        orchestration.effectiveScope === "flow" && orchestration.flowId !== undefined
          ? flows.get(orchestration.flowId)?.get(ref)
          : root.get(ref);
      if (source === undefined) return false;
      if (source.provenance?.scope === "flow" && source.provenance.flowId !== flowId) {
        return false;
      }
      if (
        repositoryIdentity === undefined ||
        source.repositoryState?.repositoryIdentity !== repositoryIdentity
      ) {
        return false;
      }
      const publishedMetadata =
        publication ??
        ({
          scope: "flow",
          flowId,
          published: true,
        } satisfies ProjectCommandEvidencePublication);
      const published = Object.freeze({
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
      if (!disk.publish(flowId, ref, published)) return false;
      const flow = flows.get(flowId) ?? new Map<string, ProjectCommandEvidenceRecord>();
      flow.set(ref, published);
      trim(flow);
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
