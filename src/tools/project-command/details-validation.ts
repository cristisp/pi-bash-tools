import {
  isBoundedOutputMetadata,
  isBoundedOutputStream,
  isBoundedString,
  isRecord,
} from "../value-validation.ts";

export interface ProjectCommandOutputDetailsValidationProfile {
  readonly commandIdMaxLength: number;
  readonly projectPathMaxLength: number;
  readonly textMaxLength: number;
  readonly totalBytesMax: number;
  readonly totalLinesMax: number;
  readonly durationMaxMs: number;
  readonly isDuration: (value: unknown, maximum: number) => boolean;
  readonly diagnosticMaxLength: number;
  readonly suggestedActionMaxLength: number;
  readonly resolvedCommandMaxLength: number;
  readonly isScope: (value: unknown) => boolean;
  readonly isErrorContract: (value: unknown) => boolean;
  readonly isExit: (value: unknown) => boolean;
  readonly isParameters: (value: unknown) => boolean;
  readonly isCacheDecision: (value: unknown) => boolean;
  readonly isStatus: (value: unknown) => boolean;
  readonly isCategory: (value: unknown) => boolean;
}

export function isStandardProjectCommandStatus(status: unknown): boolean {
  return (
    status === "success" ||
    status === "nonzero" ||
    status === "timeout" ||
    status === "spawn-failure" ||
    status === "cancelled"
  );
}

export function isStandardProjectCommandCacheDecision(decision: unknown): boolean {
  return (
    decision === "miss" ||
    decision === "hit" ||
    decision === "forced" ||
    decision === "ineligible" ||
    decision === "invalidated"
  );
}

export function isFiniteNonNegativeDuration(value: unknown, maximum: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum;
}

export interface ProjectCommandDetailsValidationInput {
  readonly value: Readonly<Record<string, unknown>>;
  readonly profile: ProjectCommandOutputDetailsValidationProfile;
}

export interface ProjectCommandOptionalDetailsValidationProfile {
  readonly isRelevantInputs: (value: unknown) => boolean;
  readonly nodeVersionMaxLength: number;
  readonly arrayMaxItems: number;
  readonly arrayItemMaxLength: number;
}

export interface ProjectCommandOptionalDetailsValidationInput {
  readonly value: Readonly<Record<string, unknown>>;
  readonly profile: ProjectCommandOptionalDetailsValidationProfile;
}

function isBoundedStringArray(
  value: unknown,
  maximumItems: number,
  itemMaxLength: number,
): boolean {
  return (
    Array.isArray(value) &&
    value.length <= maximumItems &&
    value.every((item) => isBoundedString(item, itemMaxLength))
  );
}

function isBoundedProjectCommandIdentity(
  value: Readonly<Record<string, unknown>>,
  profile: ProjectCommandOutputDetailsValidationProfile,
): boolean {
  return (
    isBoundedString(value.commandId, profile.commandIdMaxLength) &&
    isBoundedString(value.projectPath, profile.projectPathMaxLength) &&
    isBoundedString(value.fingerprint, 256) &&
    isBoundedString(value.authFingerprint, 256) &&
    isBoundedString(value.toolCallId, 256) &&
    (value.producerScope === undefined ||
      value.producerScope === "session" ||
      value.producerScope === "flow")
  );
}

function isBoundedProjectCommandExecution(
  value: Readonly<Record<string, unknown>>,
  profile: ProjectCommandOutputDetailsValidationProfile,
): boolean {
  return (
    typeof value.reused === "boolean" &&
    typeof value.forced === "boolean" &&
    profile.isCacheDecision(value.cacheDecision) &&
    profile.isDuration(value.durationMs, profile.durationMaxMs) &&
    profile.isDuration(value.executionDurationMs, profile.durationMaxMs) &&
    profile.isScope(value.scope) &&
    profile.isStatus(value.status) &&
    profile.isCategory(value.category) &&
    typeof value.executed === "boolean" &&
    (value.error === undefined || profile.isErrorContract(value.error)) &&
    profile.isExit(value.exit) &&
    typeof value.timedOut === "boolean" &&
    typeof value.cancelled === "boolean"
  );
}

function isBoundedProjectCommandOutput(
  value: Readonly<Record<string, unknown>>,
  profile: ProjectCommandOutputDetailsValidationProfile,
): boolean {
  return (
    isBoundedOutputStream(
      value.stdout,
      profile.textMaxLength,
      profile.totalBytesMax,
      profile.totalLinesMax,
    ) &&
    isBoundedOutputStream(
      value.stderr,
      profile.textMaxLength,
      profile.totalBytesMax,
      profile.totalLinesMax,
    ) &&
    isRecord(value.output) &&
    isBoundedOutputMetadata(value.output.stdout, profile.totalBytesMax, profile.totalLinesMax) &&
    isBoundedOutputMetadata(value.output.stderr, profile.totalBytesMax, profile.totalLinesMax)
  );
}

function isBoundedProjectCommandMetadata(
  value: Readonly<Record<string, unknown>>,
  profile: ProjectCommandOutputDetailsValidationProfile,
): boolean {
  return (
    (value.diagnostic === undefined ||
      isBoundedString(value.diagnostic, profile.diagnosticMaxLength)) &&
    (value.suggestedAction === undefined ||
      isBoundedString(value.suggestedAction, profile.suggestedActionMaxLength)) &&
    isBoundedString(value.resolvedCommand, profile.resolvedCommandMaxLength) &&
    profile.isParameters(value.parameters)
  );
}

export function isBoundedProjectCommandDetails({
  value,
  profile,
}: ProjectCommandDetailsValidationInput): boolean {
  return (
    isBoundedProjectCommandIdentity(value, profile) &&
    isBoundedProjectCommandExecution(value, profile) &&
    isBoundedProjectCommandOutput(value, profile) &&
    isBoundedProjectCommandMetadata(value, profile)
  );
}

export function isBoundedProjectCommandOptionalDetails({
  value,
  profile,
}: ProjectCommandOptionalDetailsValidationInput): boolean {
  return (
    (value.resultFingerprint === undefined || isBoundedString(value.resultFingerprint, 256)) &&
    (value.resultFingerprintVersion === undefined || value.resultFingerprintVersion === 1) &&
    (value.policyId === undefined || isBoundedString(value.policyId, 256)) &&
    (value.reusePolicyId === undefined || isBoundedString(value.reusePolicyId, 256)) &&
    (value.relevantInputs === undefined || profile.isRelevantInputs(value.relevantInputs)) &&
    (value.producerInvocationId === undefined ||
      isBoundedString(value.producerInvocationId, 256)) &&
    (value.nodeVersion === undefined ||
      isBoundedString(value.nodeVersion, profile.nodeVersionMaxLength)) &&
    (value.manifestPresent === undefined || typeof value.manifestPresent === "boolean") &&
    (value.scripts === undefined ||
      isBoundedStringArray(value.scripts, profile.arrayMaxItems, profile.arrayItemMaxLength)) &&
    (value.applicableCommands === undefined ||
      isBoundedStringArray(
        value.applicableCommands,
        profile.arrayMaxItems,
        profile.arrayItemMaxLength,
      ))
  );
}
