import { isBoundedSharedEvidenceFields } from "../../../evidence/envelope.ts";
import { hashCanonicalJson } from "../../../observability/canonical-json.ts";
import {
  isBoundedInteger,
  isBoundedNonEmptyString as isBoundedString,
  isRecord,
} from "../../value-validation.ts";
import {
  isBoundedProjectCommandDetails,
  isBoundedProjectCommandOptionalDetails,
} from "../details-validation.ts";
import type {
  ProjectCommandEvidenceProvenance,
  ProjectCommandEvidencePublication,
  ProjectCommandEvidenceRecord,
} from "../evidence.ts";
import {
  EVIDENCE_PROJECT_COMMAND_OPTIONAL_DETAILS_PROFILE,
  projectCommandOutputDetailsProfile,
} from "../output-details-profiles.ts";
import type { ProjectCommandOutputDetails } from "../output.ts";
import { PROJECT_COMMAND_DISPLAY_COMMAND_MAX_CHARS } from "../parameters/limits.ts";
import type { ProjectCommandRepositoryState } from "../repository-state.ts";

const PROJECT_COMMAND_EVIDENCE_FORMAT_VERSION = 1 as const;
const PROJECT_COMMAND_EVIDENCE_REF_PATTERN = /^pc_[A-Za-z0-9_-]{8,128}$/u;

export function safeEvidenceKey(value: unknown): string {
  try {
    return hashCanonicalJson(value);
  } catch {
    return hashCanonicalJson({ type: typeof value });
  }
}

function isRepositoryState(value: unknown): value is ProjectCommandRepositoryState {
  return (
    isRecord(value) &&
    isBoundedString(value.repositoryIdentity, 4096) &&
    isBoundedString(value.head, 512) &&
    isBoundedString(value.dirtyFilesDigest, 256)
  );
}

function isBoundedJson(value: unknown, maxBytes: number): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= maxBytes;
  } catch {
    return false;
  }
}

function isProvenance(value: unknown): value is ProjectCommandEvidenceProvenance {
  if (!isRecord(value)) return false;
  if (value.scope !== "session" && value.scope !== "flow") return false;
  if (value.flowId !== undefined && !isBoundedString(value.flowId, 64)) return false;
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

const EVIDENCE_OUTPUT_DETAILS_VALIDATION_PROFILE = projectCommandOutputDetailsProfile({
  projectPathMaxLength: 4096,
  diagnosticMaxLength: 50 * 1024,
  suggestedActionMaxLength: 1024,
  resolvedCommandMaxLength: PROJECT_COMMAND_DISPLAY_COMMAND_MAX_CHARS,
});

function isBoundedEvidenceCovers(value: Readonly<Record<string, unknown>>): boolean {
  return (
    value.covers === undefined ||
    (Array.isArray(value.covers) &&
      value.covers.length <= 64 &&
      value.covers.every((cover) => isBoundedString(cover, 512)))
  );
}

function isBoundedEvidencePublication(value: Readonly<Record<string, unknown>>): boolean {
  return value.publication === undefined || isPublication(value.publication);
}

function isBoundedEvidenceProvenance(value: Readonly<Record<string, unknown>>): boolean {
  return value.provenance === undefined || isProvenance(value.provenance);
}

function isBoundedEvidenceRepositoryStates(value: Readonly<Record<string, unknown>>): boolean {
  return (
    (value.repositoryState === undefined || isRepositoryState(value.repositoryState)) &&
    (value.recordedRepositoryState === undefined ||
      isRepositoryState(value.recordedRepositoryState)) &&
    (value.currentRepositoryState === undefined || isRepositoryState(value.currentRepositoryState))
  );
}

function isBoundedEvidenceRepositoryStateStatus(value: Readonly<Record<string, unknown>>): boolean {
  return (
    value.repositoryStateStatus === undefined ||
    value.repositoryStateStatus === "matches" ||
    value.repositoryStateStatus === "mismatch" ||
    value.repositoryStateStatus === "unreadable"
  );
}

function isBoundedEvidenceExecution(value: Readonly<Record<string, unknown>>): boolean {
  return (
    (value.sharedExecution === undefined || typeof value.sharedExecution === "boolean") &&
    (value.mutating === undefined || typeof value.mutating === "boolean") &&
    (value.stateDrift === undefined || typeof value.stateDrift === "boolean")
  );
}

function isBoundedEvidenceCoercions(value: Readonly<Record<string, unknown>>): boolean {
  return (
    value.coercions === undefined ||
    (Array.isArray(value.coercions) &&
      value.coercions.length <= 32 &&
      value.coercions.every((coercion) => isBoundedString(coercion, 128)))
  );
}

function isBoundedEvidenceConcurrency(value: Readonly<Record<string, unknown>>): boolean {
  return (
    value.concurrentExecutions === undefined || isBoundedInteger(value.concurrentExecutions, 0, 256)
  );
}

function isBoundedEvidenceDetailsExtensions(value: Readonly<Record<string, unknown>>): boolean {
  return (
    isBoundedEvidenceCovers(value) &&
    isBoundedEvidencePublication(value) &&
    isBoundedEvidenceProvenance(value) &&
    isBoundedEvidenceRepositoryStates(value) &&
    isBoundedEvidenceRepositoryStateStatus(value) &&
    isBoundedEvidenceExecution(value) &&
    isBoundedEvidenceCoercions(value) &&
    isBoundedEvidenceConcurrency(value)
  );
}

function isBoundedEvidenceMetadata(value: Readonly<Record<string, unknown>>): boolean {
  return (
    (value.projectInfo === undefined || isBoundedJson(value.projectInfo, 64 * 1024)) &&
    (value.packageManager === undefined || isBoundedJson(value.packageManager, 16 * 1024))
  );
}

function isEvidenceDetails(value: unknown, ref: string): value is ProjectCommandOutputDetails {
  if (!isRecord(value) || value.ref !== ref) return false;
  return (
    isBoundedProjectCommandDetails({
      value,
      profile: EVIDENCE_OUTPUT_DETAILS_VALIDATION_PROFILE,
    }) &&
    isBoundedEvidenceDetailsExtensions(value) &&
    isBoundedProjectCommandOptionalDetails({
      value,
      profile: EVIDENCE_PROJECT_COMMAND_OPTIONAL_DETAILS_PROFILE,
    }) &&
    isBoundedEvidenceMetadata(value)
  );
}

type EvidenceRecordEnvelope = Readonly<Record<string, unknown>> & {
  readonly key: string;
  readonly ref: string;
};

function isEvidenceRecordEnvelope(
  value: Readonly<Record<string, unknown>>,
): value is EvidenceRecordEnvelope {
  return (
    value.evidenceFormatVersion === PROJECT_COMMAND_EVIDENCE_FORMAT_VERSION &&
    isBoundedString(value.key, 128) &&
    isBoundedString(value.ref, 128) &&
    PROJECT_COMMAND_EVIDENCE_REF_PATTERN.test(value.ref)
  );
}

function isEvidenceRecordDetails(value: EvidenceRecordEnvelope): boolean {
  if (!isEvidenceDetails(value.details, value.ref)) return false;
  const { ref: _ref, publication: _publication, ...details } = value.details;
  return value.key === safeEvidenceKey({ ref: value.ref, details });
}

function isEvidenceRecordCovers(value: Readonly<Record<string, unknown>>): boolean {
  return (
    Array.isArray(value.covers) &&
    value.covers.length <= 64 &&
    value.covers.every((cover) => isBoundedString(cover, 512))
  );
}

function isEvidenceRecordRepositoryState(value: Readonly<Record<string, unknown>>): boolean {
  return value.repositoryState === undefined || isRepositoryState(value.repositoryState);
}

function isEvidenceRecordProvenance(value: Readonly<Record<string, unknown>>): boolean {
  return value.provenance === undefined || isProvenance(value.provenance);
}

function isEvidenceRecordPublication(value: Readonly<Record<string, unknown>>): boolean {
  return value.publication === undefined || isPublication(value.publication);
}

function isEvidenceRecordEnvelopeFields(value: Readonly<Record<string, unknown>>): boolean {
  return isBoundedSharedEvidenceFields(value, ["project-command"]);
}

function isEvidenceRecordProducer(value: Readonly<Record<string, unknown>>): boolean {
  return (
    (value.producerScope === undefined ||
      value.producerScope === "session" ||
      value.producerScope === "flow") &&
    (value.flowId === undefined || isBoundedString(value.flowId, 64)) &&
    (value.producerRole === undefined || isBoundedString(value.producerRole, 64)) &&
    (value.producerDelegationId === undefined || isBoundedString(value.producerDelegationId, 64))
  );
}

function isEvidenceRecordScope(
  value: Readonly<Record<string, unknown>>,
  scopeKey: string | undefined,
): boolean {
  return (
    scopeKey === undefined ||
    (isProvenance(value.provenance) &&
      value.provenance.scope === "flow" &&
      value.provenance.flowId === scopeKey)
  );
}

export function isEvidenceRecord(
  value: unknown,
  scopeKey?: string,
): value is ProjectCommandEvidenceRecord {
  if (!isRecord(value)) return false;
  const record = value;
  return (
    isEvidenceRecordEnvelope(record) &&
    isEvidenceRecordDetails(record) &&
    isEvidenceRecordCovers(record) &&
    isBoundedInteger(record.createdAt, 0, Number.MAX_SAFE_INTEGER) &&
    isEvidenceRecordRepositoryState(record) &&
    isEvidenceRecordProvenance(record) &&
    isEvidenceRecordPublication(record) &&
    isEvidenceRecordEnvelopeFields(record) &&
    isEvidenceRecordProducer(record) &&
    isEvidenceRecordScope(record, scopeKey)
  );
}
