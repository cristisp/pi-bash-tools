import { hashCanonicalJson } from "../../observability/canonical-json.ts";
import { RESULT_CATEGORIES } from "../errors.ts";
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
  set(record: ProjectCommandEvidenceRecord, flowId?: string): boolean;
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

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}

function isRepositoryState(value: unknown): value is ProjectCommandRepositoryState {
  return (
    isRecord(value) &&
    isBoundedString(value.repositoryIdentity, 4096) &&
    isBoundedString(value.head, 512) &&
    isBoundedString(value.dirtyFilesDigest, 256)
  );
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isOutputStream(value: unknown): boolean {
  return (
    isRecord(value) &&
    isBoundedText(value.text, 50 * 1024) &&
    typeof value.truncated === "boolean" &&
    isBoundedInteger(value.totalBytes, 0, 2 * 1024 * 1024) &&
    isBoundedInteger(value.totalLines, 0, 4_000_000)
  );
}

function isExit(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.code === null || isBoundedInteger(value.code, -1, 255)) &&
    (value.signal === null || isBoundedString(value.signal, 128))
  );
}

function isBoundedParameters(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length > 128) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= 64 * 1024;
  } catch {
    return false;
  }
}

function isBoundedJson(value: unknown, maxBytes: number): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= maxBytes;
  } catch {
    return false;
  }
}

function isResultCategory(value: unknown): boolean {
  return typeof value === "string" && RESULT_CATEGORIES.some((category) => category === value);
}

function isErrorContract(value: unknown): boolean {
  return (
    isRecord(value) &&
    isBoundedString(value.code, 256) &&
    typeof value.category === "string" &&
    value.category !== "PASS" &&
    isResultCategory(value.category) &&
    isBoundedString(value.explanation, 8 * 1024) &&
    (value.invalidField === undefined || isBoundedString(value.invalidField, 256)) &&
    (value.correctedExample === undefined || isBoundedJson(value.correctedExample, 16 * 1024)) &&
    (value.suggestedAction === undefined || isBoundedString(value.suggestedAction, 8 * 1024)) &&
    typeof value.retryable === "boolean" &&
    typeof value.executed === "boolean"
  );
}

function isProvenance(value: unknown): value is ProjectCommandEvidenceProvenance {
  if (!isRecord(value)) return false;
  if (value.scope !== "session" && value.scope !== "flow") return false;
  if (value.flowId !== undefined && !isBoundedString(value.flowId, 64)) {
    return false;
  }
  if (value.scope === "flow" && value.flowId === undefined) return false;
  return (
    (value.producerInvocationId === undefined ||
      isBoundedString(value.producerInvocationId, 256)) &&
    (value.producerSessionId === undefined || isBoundedString(value.producerSessionId, 256)) &&
    (value.producerRole === undefined || isBoundedString(value.producerRole, 64)) &&
    (value.producerDelegationId === undefined || isBoundedString(value.producerDelegationId, 64))
  );
}

function isPublication(value: unknown): value is ProjectCommandEvidencePublication {
  return (
    isRecord(value) &&
    value.scope === "flow" &&
    isBoundedString(value.flowId, 64) &&
    typeof value.published === "boolean" &&
    (value.error === undefined || isBoundedString(value.error, 256))
  );
}

function isEvidenceDetails(value: unknown, ref: string): value is ProjectCommandOutputDetails {
  if (!isRecord(value) || value.ref !== ref) return false;
  const scope = value.scope;
  return (
    isBoundedString(value.commandId, 128) &&
    isRecord(scope) &&
    scope.cwdStrategy === "canonical-project" &&
    isBoundedString(scope.projectPath, 4096) &&
    isBoundedString(value.projectPath, 4096) &&
    isBoundedString(value.fingerprint, 256) &&
    isBoundedString(value.authFingerprint, 256) &&
    isBoundedString(value.toolCallId, 256) &&
    (value.covers === undefined ||
      (Array.isArray(value.covers) &&
        value.covers.length <= 64 &&
        value.covers.every((cover) => isBoundedString(cover, 512)))) &&
    (value.publication === undefined || isPublication(value.publication)) &&
    (value.provenance === undefined || isProvenance(value.provenance)) &&
    (value.repositoryState === undefined || isRepositoryState(value.repositoryState)) &&
    (value.recordedRepositoryState === undefined ||
      isRepositoryState(value.recordedRepositoryState)) &&
    (value.currentRepositoryState === undefined ||
      isRepositoryState(value.currentRepositoryState)) &&
    (value.repositoryStateStatus === undefined ||
      value.repositoryStateStatus === "matches" ||
      value.repositoryStateStatus === "mismatch" ||
      value.repositoryStateStatus === "unreadable") &&
    (value.sharedExecution === undefined || typeof value.sharedExecution === "boolean") &&
    (value.coercions === undefined ||
      (Array.isArray(value.coercions) &&
        value.coercions.length <= 32 &&
        value.coercions.every((coercion) => isBoundedString(coercion, 128)))) &&
    (value.mutating === undefined || typeof value.mutating === "boolean") &&
    (value.concurrentExecutions === undefined ||
      isBoundedInteger(value.concurrentExecutions, 0, 256)) &&
    (value.stateDrift === undefined || typeof value.stateDrift === "boolean") &&
    (value.resultFingerprint === undefined || isBoundedString(value.resultFingerprint, 256)) &&
    (value.resultFingerprintVersion === undefined || value.resultFingerprintVersion === 1) &&
    (value.policyId === undefined || isBoundedString(value.policyId, 256)) &&
    (value.reusePolicyId === undefined || isBoundedString(value.reusePolicyId, 256)) &&
    (value.relevantInputs === undefined || isBoundedParameters(value.relevantInputs)) &&
    (value.producerInvocationId === undefined ||
      isBoundedString(value.producerInvocationId, 256)) &&
    (value.projectInfo === undefined || isBoundedJson(value.projectInfo, 64 * 1024)) &&
    (value.nodeVersion === undefined || isBoundedString(value.nodeVersion, 128)) &&
    (value.manifestPresent === undefined || typeof value.manifestPresent === "boolean") &&
    (value.packageManager === undefined || isBoundedJson(value.packageManager, 16 * 1024)) &&
    (value.scripts === undefined ||
      (Array.isArray(value.scripts) &&
        value.scripts.length <= 256 &&
        value.scripts.every((script) => isBoundedString(script, 256)))) &&
    (value.applicableCommands === undefined ||
      (Array.isArray(value.applicableCommands) &&
        value.applicableCommands.length <= 256 &&
        value.applicableCommands.every((command) => isBoundedString(command, 256)))) &&
    (value.producerScope === undefined ||
      value.producerScope === "session" ||
      value.producerScope === "flow") &&
    typeof value.reused === "boolean" &&
    typeof value.forced === "boolean" &&
    (value.cacheDecision === "miss" ||
      value.cacheDecision === "hit" ||
      value.cacheDecision === "forced" ||
      value.cacheDecision === "ineligible" ||
      value.cacheDecision === "invalidated") &&
    isBoundedInteger(value.durationMs, 0, 24 * 60 * 60 * 1000) &&
    isBoundedInteger(value.executionDurationMs, 0, 24 * 60 * 60 * 1000) &&
    (value.status === "success" ||
      value.status === "nonzero" ||
      value.status === "timeout" ||
      value.status === "spawn-failure" ||
      value.status === "cancelled") &&
    isResultCategory(value.category) &&
    typeof value.executed === "boolean" &&
    (value.error === undefined || isErrorContract(value.error)) &&
    isExit(value.exit) &&
    typeof value.timedOut === "boolean" &&
    typeof value.cancelled === "boolean" &&
    isOutputStream(value.stdout) &&
    isOutputStream(value.stderr) &&
    isRecord(value.output) &&
    isOutputStreamMetadata(value.output.stdout) &&
    isOutputStreamMetadata(value.output.stderr) &&
    (value.diagnostic === undefined || isBoundedString(value.diagnostic, 50 * 1024)) &&
    (value.suggestedAction === undefined || isBoundedString(value.suggestedAction, 1024)) &&
    isBoundedString(value.resolvedCommand, 50 * 1024) &&
    isBoundedParameters(value.parameters)
  );
}

function isOutputStreamMetadata(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.truncated === "boolean" &&
    isBoundedInteger(value.totalBytes, 0, 2 * 1024 * 1024) &&
    isBoundedInteger(value.totalLines, 0, 4_000_000)
  );
}

export function isEvidenceRecord(
  value: unknown,
  scopeKey?: string,
): value is ProjectCommandEvidenceRecord {
  if (!isRecord(value)) return false;
  const record = value;
  if (
    record.evidenceFormatVersion !== PROJECT_COMMAND_EVIDENCE_FORMAT_VERSION ||
    !isBoundedString(record.key, 128) ||
    !isBoundedString(record.ref, 128) ||
    !PROJECT_COMMAND_EVIDENCE_REF_PATTERN.test(record.ref) ||
    !isEvidenceDetails(record.details, record.ref) ||
    record.key !==
      safeKey({
        ref: record.ref,
        details: (() => {
          const { ref: _ref, publication: _publication, ...details } = record.details;
          return details;
        })(),
      }) ||
    !Array.isArray(record.covers) ||
    record.covers.length > 64 ||
    !record.covers.every((cover) => isBoundedString(cover, 512)) ||
    !isBoundedInteger(record.createdAt, 0, Number.MAX_SAFE_INTEGER) ||
    (record.repositoryState !== undefined && !isRepositoryState(record.repositoryState)) ||
    (record.provenance !== undefined && !isProvenance(record.provenance)) ||
    (record.publication !== undefined && !isPublication(record.publication)) ||
    (record.producerScope !== undefined &&
      record.producerScope !== "session" &&
      record.producerScope !== "flow") ||
    (record.flowId !== undefined && !isBoundedString(record.flowId, 64)) ||
    (record.producerRole !== undefined && !isBoundedString(record.producerRole, 64)) ||
    (record.producerDelegationId !== undefined && !isBoundedString(record.producerDelegationId, 64))
  ) {
    return false;
  }
  return (
    scopeKey === undefined ||
    (record.provenance?.scope === "flow" && record.provenance.flowId === scopeKey)
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
        trim(root);
        return true;
      }
      if (!disk.set(flowId, record.ref, record)) return false;
      const flow = flows.get(flowId) ?? new Map<string, ProjectCommandEvidenceRecord>();
      flow.set(record.ref, record);
      trim(flow);
      flows.set(flowId, flow);
      return true;
    },
    publish(ref, flowId, repositoryIdentity, publication) {
      if (
        publication?.scope !== "flow" ||
        publication.flowId !== flowId ||
        !publication.published
      ) {
        return false;
      }
      const orchestration = readProjectCommandOrchestrationContext();
      if (orchestration.effectiveScope === "flow" && orchestration.flowId !== flowId) {
        return false;
      }
      const source =
        orchestration.effectiveScope === "flow" && orchestration.flowId !== undefined
          ? flows.get(orchestration.flowId)?.get(ref)
          : root.get(ref);
      if (
        source === undefined ||
        !isEvidenceRecord(source, orchestration.effectiveScope === "flow" ? flowId : undefined)
      ) {
        return false;
      }
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
      if (!isEvidenceRecord(published, flowId)) return false;
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
