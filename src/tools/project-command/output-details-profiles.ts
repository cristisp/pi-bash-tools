import { RESULT_CATEGORIES } from "../errors.ts";
import {
  isBoundedNonEmptyString as isBoundedString,
  isNullableBoundedInteger,
  isRecord,
} from "../value-validation.ts";
import { PROJECT_COMMAND_OUTPUT_LIMIT_BYTES } from "./definitions.ts";
import {
  isFiniteNonNegativeDuration,
  isStandardProjectCommandCacheDecision,
  isStandardProjectCommandStatus,
  type ProjectCommandOptionalDetailsValidationProfile,
  type ProjectCommandOutputDetailsValidationProfile,
} from "./details-validation.ts";

const PROJECT_COMMAND_EXIT_CODE_MIN = 0;
const PROJECT_COMMAND_EXIT_CODE_MAX = 255;
const PROJECT_COMMAND_EXIT_SIGNAL_MAX_LENGTH = 128;
const PROJECT_COMMAND_IDENTITY_MAX_LENGTH = 256;
const PROJECT_COMMAND_TEXT_MAX_LENGTH = PROJECT_COMMAND_OUTPUT_LIMIT_BYTES;
const PROJECT_COMMAND_TOTAL_MAX = Number.MAX_SAFE_INTEGER;
const PROJECT_COMMAND_DURATION_MAX_MS = 24 * 60 * 60 * 1_000;
const PROJECT_COMMAND_PARAMETERS_MAX_KEYS = 128;
const PROJECT_COMMAND_PARAMETERS_MAX_JSON_BYTES = 1024 * 1024;
const PROJECT_COMMAND_ERROR_CODE_MAX_LENGTH = 256;
const PROJECT_COMMAND_ERROR_EXPLANATION_MAX_LENGTH = 8 * 1024;
const PROJECT_COMMAND_ERROR_INVALID_FIELD_MAX_LENGTH = 256;
const PROJECT_COMMAND_ERROR_CORRECTED_EXAMPLE_MAX_JSON_BYTES = 16 * 1024;
const PROJECT_COMMAND_ERROR_SUGGESTED_ACTION_MAX_LENGTH = 8 * 1024;

function isBoundedJson(value: unknown, maxBytes: number): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= maxBytes;
  } catch {
    return false;
  }
}

function isProjectCommandExit(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNullableBoundedInteger(
      value.code,
      PROJECT_COMMAND_EXIT_CODE_MIN,
      PROJECT_COMMAND_EXIT_CODE_MAX,
    ) &&
    (value.signal === null || isBoundedString(value.signal, PROJECT_COMMAND_EXIT_SIGNAL_MAX_LENGTH))
  );
}

function isBoundedProjectCommandParameters(
  value: unknown,
  maxKeys: number,
  maxJsonBytes: number,
): boolean {
  if (!isRecord(value) || Object.keys(value).length > maxKeys) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= maxJsonBytes;
  } catch {
    return false;
  }
}

function isProjectCommandResultCategory(value: unknown): boolean {
  return typeof value === "string" && RESULT_CATEGORIES.some((category) => category === value);
}

function isProjectCommandErrorContract(value: unknown): boolean {
  return (
    isRecord(value) &&
    isBoundedString(value.code, PROJECT_COMMAND_ERROR_CODE_MAX_LENGTH) &&
    typeof value.category === "string" &&
    value.category !== "PASS" &&
    isProjectCommandResultCategory(value.category) &&
    isBoundedString(value.explanation, PROJECT_COMMAND_ERROR_EXPLANATION_MAX_LENGTH) &&
    (value.invalidField === undefined ||
      isBoundedString(value.invalidField, PROJECT_COMMAND_ERROR_INVALID_FIELD_MAX_LENGTH)) &&
    (value.correctedExample === undefined ||
      isBoundedJson(
        value.correctedExample,
        PROJECT_COMMAND_ERROR_CORRECTED_EXAMPLE_MAX_JSON_BYTES,
      )) &&
    (value.suggestedAction === undefined ||
      isBoundedString(value.suggestedAction, PROJECT_COMMAND_ERROR_SUGGESTED_ACTION_MAX_LENGTH)) &&
    typeof value.retryable === "boolean" &&
    typeof value.executed === "boolean"
  );
}

function isCanonicalProjectCommandScope(value: unknown, projectPathMaxLength: number): boolean {
  return (
    isRecord(value) &&
    value.cwdStrategy === "canonical-project" &&
    isBoundedString(value.projectPath, projectPathMaxLength)
  );
}

export interface ProjectCommandOutputDetailsProfileDeltas {
  readonly projectPathMaxLength: number;
  readonly diagnosticMaxLength: number;
  readonly suggestedActionMaxLength: number;
  readonly resolvedCommandMaxLength: number;
}

export function projectCommandOutputDetailsProfile(
  deltas: ProjectCommandOutputDetailsProfileDeltas,
): ProjectCommandOutputDetailsValidationProfile {
  return {
    commandIdMaxLength: PROJECT_COMMAND_IDENTITY_MAX_LENGTH,
    projectPathMaxLength: deltas.projectPathMaxLength,
    textMaxLength: PROJECT_COMMAND_TEXT_MAX_LENGTH,
    totalBytesMax: PROJECT_COMMAND_TOTAL_MAX,
    totalLinesMax: PROJECT_COMMAND_TOTAL_MAX,
    durationMaxMs: PROJECT_COMMAND_DURATION_MAX_MS,
    isDuration: isFiniteNonNegativeDuration,
    diagnosticMaxLength: deltas.diagnosticMaxLength,
    suggestedActionMaxLength: deltas.suggestedActionMaxLength,
    resolvedCommandMaxLength: deltas.resolvedCommandMaxLength,
    isScope: (candidate) => isCanonicalProjectCommandScope(candidate, deltas.projectPathMaxLength),
    isErrorContract: isProjectCommandErrorContract,
    isExit: isProjectCommandExit,
    isParameters: (value) =>
      isBoundedProjectCommandParameters(
        value,
        PROJECT_COMMAND_PARAMETERS_MAX_KEYS,
        PROJECT_COMMAND_PARAMETERS_MAX_JSON_BYTES,
      ),
    isCacheDecision: isStandardProjectCommandCacheDecision,
    isStatus: isStandardProjectCommandStatus,
    isCategory: isProjectCommandResultCategory,
  };
}

const PROJECT_COMMAND_CACHE_FIELD_MAX_LENGTH = 8 * 1024;
const PROJECT_COMMAND_CACHE_RELEVANT_INPUTS_MAX_ITEMS = 4_096;

function isBoundedCacheString(
  value: unknown,
  maxLength = PROJECT_COMMAND_CACHE_FIELD_MAX_LENGTH,
): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isCacheRelevantInputs(value: unknown): boolean {
  return (
    isRecord(value) &&
    isBoundedCacheRelevantInputArray(value.files, "file", (file) =>
      isBoundedCacheString(file.path),
    ) &&
    isBoundedCacheRelevantInputArray(
      value.values,
      "value",
      (entry) => isBoundedCacheString(entry.name, 256) && isBoundedCacheString(entry.value),
    )
  );
}

function isBoundedCacheRelevantInputArray(
  value: unknown,
  kind: string,
  isBoundedEntry: (entry: Readonly<Record<string, unknown>>) => boolean,
): boolean {
  return (
    Array.isArray(value) &&
    value.length <= PROJECT_COMMAND_CACHE_RELEVANT_INPUTS_MAX_ITEMS &&
    value.every((entry) => isRecord(entry) && entry.kind === kind && isBoundedEntry(entry))
  );
}

export const EVIDENCE_PROJECT_COMMAND_OPTIONAL_DETAILS_PROFILE: ProjectCommandOptionalDetailsValidationProfile =
  {
    isRelevantInputs: (value) =>
      isBoundedProjectCommandParameters(value, PROJECT_COMMAND_PARAMETERS_MAX_KEYS, 64 * 1024),
    nodeVersionMaxLength: 128,
    arrayMaxItems: 256,
    arrayItemMaxLength: 256,
  };

export const CACHE_PROJECT_COMMAND_OPTIONAL_DETAILS_PROFILE: ProjectCommandOptionalDetailsValidationProfile =
  {
    isRelevantInputs: isCacheRelevantInputs,
    nodeVersionMaxLength: 256,
    arrayMaxItems: PROJECT_COMMAND_CACHE_RELEVANT_INPUTS_MAX_ITEMS,
    arrayItemMaxLength: 256,
  };
