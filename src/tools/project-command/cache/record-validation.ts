import { isRecord } from "../../value-validation.ts";
import type { ProjectCommandCacheProvenance } from "../cache.ts";
import {
  isBoundedProjectCommandDetails,
  isBoundedProjectCommandOptionalDetails,
} from "../details-validation.ts";
import {
  CACHE_PROJECT_COMMAND_OPTIONAL_DETAILS_PROFILE,
  projectCommandOutputDetailsProfile,
} from "../output-details-profiles.ts";
import type { ProjectCommandOutputDetails } from "../output.ts";
import { PROJECT_COMMAND_DISPLAY_COMMAND_MAX_CHARS } from "../parameters/limits.ts";
import type { ProjectCommandStateSnapshot } from "../state-snapshot.ts";

export const CACHE_ENTRY_FORMAT_VERSION = 1 as const;
const CACHE_FIELD_MAX_LENGTH = 8 * 1024;
const CACHE_ARRAY_MAX_ITEMS = 4_096;

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

const CACHE_OUTPUT_DETAILS_VALIDATION_PROFILE = projectCommandOutputDetailsProfile({
  projectPathMaxLength: CACHE_FIELD_MAX_LENGTH,
  diagnosticMaxLength: 50 * 1024,
  suggestedActionMaxLength: 1024,
  resolvedCommandMaxLength: PROJECT_COMMAND_DISPLAY_COMMAND_MAX_CHARS,
});

function isOutputDetails(value: unknown): value is ProjectCommandOutputDetails {
  if (!isRecord(value)) return false;
  return (
    isBoundedProjectCommandDetails({
      value,
      profile: CACHE_OUTPUT_DETAILS_VALIDATION_PROFILE,
    }) &&
    isBoundedProjectCommandOptionalDetails({
      value,
      profile: CACHE_PROJECT_COMMAND_OPTIONAL_DETAILS_PROFILE,
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
