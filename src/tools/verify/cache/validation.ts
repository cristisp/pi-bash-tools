import { isAbsolute } from "node:path";

import { isBoundedSharedEvidenceFields } from "../../../evidence/envelope.ts";
import {
  isBoundedInteger,
  isBoundedNonEmptyString,
  isBoundedString,
  isRecord,
} from "../../value-validation.ts";
import {
  VERIFY_CACHE_FORMAT_VERSION,
  VERIFY_PHASES,
  type VerifyEvidenceRecord,
  type VerifyRepositoryState,
} from "../types.ts";
import {
  isSafeFailureTail,
  isVerifyStepResult,
  VERIFY_CACHE_MAX_COMMAND,
} from "./step-validation.ts";

const VERIFY_CACHE_MAX_TAIL = 8 * 1024;
const VERIFY_CACHE_MAX_STEPS = 4;
const VERIFY_CACHE_MAX_COMMANDS = 4;
const VERIFY_CACHE_MAX_COVERS = 64;
const VERIFY_CACHE_MAX_COVER_LENGTH = 512;

function isRepositoryState(value: unknown): value is VerifyRepositoryState {
  return (
    isRecord(value) &&
    isBoundedString(value.repositoryIdentity, 4096) &&
    isBoundedString(value.workingDirectory, 4096) &&
    isBoundedString(value.head, 512) &&
    isBoundedString(value.dirtyFilesDigest, 256)
  );
}

function isProvenance(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (value.scope === "root" || value.scope === "flow") &&
    (value.flowId === undefined || isBoundedNonEmptyString(value.flowId, 64)) &&
    (value.repositoryIdentity === undefined || isBoundedString(value.repositoryIdentity, 4096))
  );
}

function isPublication(value: unknown): boolean {
  return (
    isRecord(value) &&
    isBoundedNonEmptyString(value.flowId, 64) &&
    isBoundedNonEmptyString(value.repositoryIdentity, 4096) &&
    (value.producerScope === "root" || value.producerScope === "flow") &&
    typeof value.published === "boolean"
  );
}

function hasConsistentVerdict(value: Readonly<Record<string, unknown>>): boolean {
  if (!Array.isArray(value.perStep)) return false;
  const steps = value.perStep.filter(isVerifyStepResult);
  if (steps.length !== value.perStep.length) return false;
  const expected = steps.some((step) => step.status === "failed" || step.status === "not-run")
    ? "failed"
    : steps.some((step) => step.status === "omitted")
      ? "incomplete"
      : "passed";
  return steps.every((step) => step.verdict === step.status) && value.verdict === expected;
}

function isVerifyRecordIdentity(
  value: Readonly<Record<string, unknown>>,
  logicalRequestKey: string | undefined,
): boolean {
  return (
    isBoundedString(value.key, 256) &&
    (logicalRequestKey === undefined || value.key === logicalRequestKey) &&
    isBoundedString(value.ref, 128) &&
    value.ref === `vr_${value.key.slice(0, 24)}`
  );
}

function isVerifyRecordProjectPath(value: Readonly<Record<string, unknown>>): boolean {
  return isBoundedString(value.projectPath, 4096) && isAbsolute(value.projectPath);
}

function isVerifyRecordRepositoryState(value: Readonly<Record<string, unknown>>): boolean {
  return (
    value.repositoryState === undefined ||
    (isRepositoryState(value.repositoryState) &&
      value.repositoryState.workingDirectory === value.projectPath)
  );
}

function isVerifyRecordOptionalMetadata(value: Readonly<Record<string, unknown>>): boolean {
  return (
    (value.provenance === undefined || isProvenance(value.provenance)) &&
    (value.publication === undefined || isPublication(value.publication)) &&
    (value.mutating === undefined || typeof value.mutating === "boolean") &&
    (value.concurrentExecutions === undefined ||
      isBoundedInteger(value.concurrentExecutions, 0, 256)) &&
    (value.stateDrift === undefined || typeof value.stateDrift === "boolean") &&
    (value.sharedExecution === undefined || typeof value.sharedExecution === "boolean")
  );
}

function isVerifyRecordMetadata(
  value: Readonly<Record<string, unknown>>,
  logicalRequestKey: string | undefined,
): boolean {
  return (
    value.cacheFormatVersion === VERIFY_CACHE_FORMAT_VERSION &&
    isVerifyRecordIdentity(value, logicalRequestKey) &&
    isVerifyRecordProjectPath(value) &&
    isVerifyRecordRepositoryState(value) &&
    isVerifyRecordOptionalMetadata(value)
  );
}

function isVerifyRecordSteps(value: Readonly<Record<string, unknown>>): boolean {
  return (
    Array.isArray(value.resolvedCommands) &&
    value.resolvedCommands.length > 0 &&
    value.resolvedCommands.length <= VERIFY_CACHE_MAX_COMMANDS &&
    value.resolvedCommands.every((command) => isBoundedString(command, VERIFY_CACHE_MAX_COMMAND)) &&
    Array.isArray(value.perStep) &&
    value.perStep.length === VERIFY_CACHE_MAX_STEPS &&
    value.perStep.every(isVerifyStepResult) &&
    value.perStep.every(
      (step, index) => isVerifyStepResult(step) && step.phase === VERIFY_PHASES[index],
    )
  );
}

function isVerifyRecordOutcome(value: Readonly<Record<string, unknown>>): boolean {
  return (
    (value.verdict === "passed" || value.verdict === "failed" || value.verdict === "incomplete") &&
    (value.verdict !== "failed" ||
      isBoundedNonEmptyString(value.failureTail, VERIFY_CACHE_MAX_TAIL)) &&
    isSafeFailureTail(value.failureTail, value.verdict) &&
    Array.isArray(value.covers) &&
    value.covers.length <= VERIFY_CACHE_MAX_COVERS &&
    value.covers.every(
      (cover) => isBoundedString(cover, VERIFY_CACHE_MAX_COVER_LENGTH) && cover.length > 0,
    ) &&
    isBoundedInteger(value.createdAt, 0, Number.MAX_SAFE_INTEGER) &&
    hasConsistentVerdict(value)
  );
}

function isVerifyRecordEnvelopeFields(value: Readonly<Record<string, unknown>>): boolean {
  return isBoundedSharedEvidenceFields(value, ["verify"]);
}

export function isVerifyEvidenceRecord(
  value: unknown,
  logicalRequestKey?: string,
): value is VerifyEvidenceRecord {
  if (!isRecord(value)) return false;
  return (
    isVerifyRecordMetadata(value, logicalRequestKey) &&
    isVerifyRecordSteps(value) &&
    isVerifyRecordOutcome(value) &&
    isVerifyRecordEnvelopeFields(value)
  );
}

export function isVerifyRefAlias(
  value: unknown,
  logicalRequestKey: string,
): value is Readonly<{ readonly key: string; readonly record: VerifyEvidenceRecord }> {
  if (!isRecord(value) || !isBoundedString(value.key, 256) || value.key !== logicalRequestKey) {
    return false;
  }
  if (!isVerifyEvidenceRecord(value.record)) return false;
  return (
    value.key === `ref:${value.record.ref}` &&
    value.record.ref === logicalRequestKey.slice("ref:".length)
  );
}

export function isVerifyEvidenceCacheRecord(value: unknown, logicalRequestKey: string): boolean {
  if (logicalRequestKey.startsWith("ref:")) {
    return isVerifyRefAlias(value, logicalRequestKey);
  }
  return isVerifyEvidenceRecord(value, logicalRequestKey);
}
