import { isRecord } from "../../value-validation.ts";
import type { ProjectCommandCacheProvenance } from "../cache.ts";
import {
  isBoundedProjectCommandDetails,
  isBoundedProjectCommandOptionalDetails,
  isFiniteNonNegativeDuration,
  isStandardProjectCommandStatus,
  type ProjectCommandOptionalDetailsValidationProfile,
  type ProjectCommandOutputDetailsValidationProfile,
} from "../details-validation.ts";
import type { ProjectCommandOutputDetails } from "../output.ts";
import type { ProjectCommandStateSnapshot } from "../state-snapshot.ts";

const CACHE_ENTRY_FORMAT_VERSION = 1 as const;
const CACHE_ENTRY_MAX_BYTES = 2 * 1024 * 1024;
const CACHE_FIELD_MAX_LENGTH = 8 * 1024;
const CACHE_ARRAY_MAX_ITEMS = 4_096;
const CACHE_TOTAL_BYTES_MAX = Number.MAX_SAFE_INTEGER;
const CACHE_TOTAL_LINES_MAX = Number.MAX_SAFE_INTEGER;
const CACHE_DURATION_MAX_MS = 24 * 60 * 60 * 1_000;

type DiskCacheRecord = {
  readonly cacheFormatVersion: typeof CACHE_ENTRY_FORMAT_VERSION;
  readonly logicalRequestKey: string;
  readonly resultFingerprint: string;
  readonly details: ProjectCommandOutputDetails;
  readonly snapshot: ProjectCommandStateSnapshot;
  readonly producerInvocationId: string;
  readonly provenance?: ProjectCommandCacheProvenance;
};

function isBoundedString(value: unknown, maxLength = CACHE_FIELD_MAX_LENGTH): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isStateSnapshot(value: unknown): value is ProjectCommandStateSnapshot {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > CACHE_ARRAY_MAX_ITEMS
  ) {
    return false;
  }
  return value.entries.every(
    (entry) => isRecord(entry) && isBoundedString(entry.path) && isBoundedString(entry.type, 128),
  );
}

function isBoundedNonNegativeInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function isExit(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.code === null || isBoundedNonNegativeInteger(value.code, 255)) &&
    (value.signal === null || isBoundedString(value.signal, 128))
  );
}

function isScope(value: unknown): boolean {
  return (
    isRecord(value) && isBoundedString(value.cwdStrategy, 128) && isBoundedString(value.projectPath)
  );
}

function isErrorContract(value: unknown): boolean {
  return (
    isRecord(value) &&
    isBoundedString(value.code, 256) &&
    isBoundedString(value.category, 256) &&
    isBoundedString(value.explanation) &&
    (value.invalidField === undefined || isBoundedString(value.invalidField, 256)) &&
    (value.suggestedAction === undefined || isBoundedString(value.suggestedAction)) &&
    typeof value.retryable === "boolean" &&
    typeof value.executed === "boolean"
  );
}

function isRelevantInputs(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.files) &&
    value.files.length <= CACHE_ARRAY_MAX_ITEMS &&
    value.files.every(
      (file) => isRecord(file) && file.kind === "file" && isBoundedString(file.path),
    ) &&
    Array.isArray(value.values) &&
    value.values.length <= CACHE_ARRAY_MAX_ITEMS &&
    value.values.every(
      (entry) =>
        isRecord(entry) &&
        entry.kind === "value" &&
        isBoundedString(entry.name, 256) &&
        isBoundedString(entry.value),
    )
  );
}

const CACHE_OUTPUT_DETAILS_VALIDATION_PROFILE: ProjectCommandOutputDetailsValidationProfile = {
  commandIdMaxLength: 256,
  projectPathMaxLength: CACHE_FIELD_MAX_LENGTH,
  textMaxLength: CACHE_ENTRY_MAX_BYTES,
  totalBytesMax: CACHE_TOTAL_BYTES_MAX,
  totalLinesMax: CACHE_TOTAL_LINES_MAX,
  durationMaxMs: CACHE_DURATION_MAX_MS,
  isDuration: isFiniteNonNegativeDuration,
  diagnosticMaxLength: CACHE_FIELD_MAX_LENGTH,
  suggestedActionMaxLength: CACHE_FIELD_MAX_LENGTH,
  resolvedCommandMaxLength: CACHE_ENTRY_MAX_BYTES,
  isScope,
  isErrorContract,
  isExit,
  isParameters: isRecord,
  isCacheDecision: (decision) => isBoundedString(decision, 128),
  isStatus: isStandardProjectCommandStatus,
  isCategory: (category) => isBoundedString(category, 256),
};

const CACHE_OPTIONAL_DETAILS_VALIDATION_PROFILE: ProjectCommandOptionalDetailsValidationProfile = {
  isRelevantInputs,
  nodeVersionMaxLength: 256,
  arrayMaxItems: CACHE_ARRAY_MAX_ITEMS,
  arrayItemMaxLength: 256,
};

function isOutputDetails(value: unknown): value is ProjectCommandOutputDetails {
  if (!isRecord(value)) return false;
  return (
    isBoundedProjectCommandDetails({
      value,
      profile: CACHE_OUTPUT_DETAILS_VALIDATION_PROFILE,
    }) &&
    isBoundedProjectCommandOptionalDetails({
      value,
      profile: CACHE_OPTIONAL_DETAILS_VALIDATION_PROFILE,
    })
  );
}

export function isCacheProvenance(value: unknown): value is ProjectCommandCacheProvenance {
  if (!isRecord(value)) return false;
  return (
    isBoundedString(value.producerSessionId, 256) &&
    (value.producerRole === undefined || isBoundedString(value.producerRole, 256)) &&
    isBoundedString(value.flowId, 64) &&
    isBoundedString(value.repositoryIdentity) &&
    isBoundedString(value.workingDirectory) &&
    isBoundedString(value.head, 256) &&
    isBoundedString(value.dirtyFilesDigest, 256) &&
    isBoundedString(value.snapshotDigest, 256) &&
    typeof value.writeTimestamp === "number" &&
    Number.isFinite(value.writeTimestamp)
  );
}

export function isCacheEntry(
  value: unknown,
  logicalRequestKey?: string,
  scopeKey?: string,
): value is DiskCacheRecord {
  if (!isRecord(value)) return false;
  if (
    logicalRequestKey !== undefined &&
    (typeof value.logicalRequestKey !== "string" || value.logicalRequestKey !== logicalRequestKey)
  ) {
    return false;
  }
  if (!isCacheProvenance(value.provenance)) return false;
  return (
    value.cacheFormatVersion === CACHE_ENTRY_FORMAT_VERSION &&
    isBoundedString(value.logicalRequestKey, CACHE_FIELD_MAX_LENGTH) &&
    isBoundedString(value.resultFingerprint, 256) &&
    isOutputDetails(value.details) &&
    isStateSnapshot(value.snapshot) &&
    isBoundedString(value.producerInvocationId, 256) &&
    (scopeKey === undefined || value.provenance.flowId === scopeKey)
  );
}
