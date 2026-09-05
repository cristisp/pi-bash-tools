import { isAbsolute } from "node:path";
import {
  createProjectCommandDiskJsonCache,
  type ProjectCommandDiskJsonCache,
} from "../project-command/cache.ts";
import { readProjectCommandOrchestrationContext } from "../project-command/orchestration.ts";
import {
  VERIFY_CACHE_FORMAT_VERSION,
  VERIFY_PHASES,
  type VerifyEvidenceRecord,
  type VerifyOutputChunk,
  type VerifyRepositoryState,
  type VerifyStepResult,
} from "./types.ts";

const VERIFY_CACHE_MAX_TEXT = 50 * 1024;
const VERIFY_CACHE_MAX_TAIL = 8 * 1024;
const ANSI_ESCAPE = String.fromCodePoint(0x1b);
const VERIFY_CACHE_MAX_STEPS = 4;
const VERIFY_CACHE_MAX_COMMANDS = 4;
const VERIFY_CACHE_MAX_COVERS = 64;
const VERIFY_CACHE_MAX_COVER_LENGTH = 512;
const VERIFY_CACHE_MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const VERIFY_CACHE_MAX_BYTES = 2 * 1024 * 1024;
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}

function isNullableBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number | null {
  return value === null || isBoundedInteger(value, minimum, maximum);
}

function isOutputChunk(value: unknown): value is VerifyOutputChunk {
  return (
    isRecord(value) &&
    isBoundedString(value.text, VERIFY_CACHE_MAX_TEXT) &&
    typeof value.truncated === "boolean" &&
    isBoundedInteger(value.totalBytes, 0, VERIFY_CACHE_MAX_BYTES) &&
    isBoundedInteger(value.totalLines, 0, VERIFY_CACHE_MAX_BYTES)
  );
}

function isEmptyChunk(value: unknown): boolean {
  return (
    isOutputChunk(value) &&
    value.text === "" &&
    !value.truncated &&
    value.totalBytes === 0 &&
    value.totalLines === 0
  );
}

function isSafeFailureTail(value: unknown, status: unknown): value is string | undefined {
  return (
    value === undefined ||
    (status === "failed" &&
      isBoundedString(value, VERIFY_CACHE_MAX_TAIL) &&
      !value.includes(ANSI_ESCAPE))
  );
}

function isStep(value: unknown): value is VerifyStepResult {
  if (!isRecord(value)) return false;
  const status = value.status;
  const verdict = value.verdict;
  const baseValid =
    (value.phase === "format" ||
      value.phase === "lint" ||
      value.phase === "typecheck" ||
      value.phase === "test") &&
    (status === "passed" || status === "failed" || status === "omitted" || status === "not-run") &&
    (verdict === "passed" ||
      verdict === "failed" ||
      verdict === "omitted" ||
      verdict === "not-run") &&
    isNullableBoundedInteger(value.exitCode, -1, 255) &&
    (value.signal === null || isBoundedString(value.signal, 128)) &&
    isBoundedInteger(value.durationMs, 0, VERIFY_CACHE_MAX_DURATION_MS) &&
    typeof value.executed === "boolean" &&
    isOutputChunk(value.stdout) &&
    isOutputChunk(value.stderr) &&
    isSafeFailureTail(value.failureTail, status) &&
    (value.reason === undefined || isBoundedString(value.reason, 1024));
  if (!baseValid) return false;
  if (status === "passed" || status === "failed") {
    const activeCommand =
      isBoundedNonEmptyString(value.command, 4096) &&
      isBoundedNonEmptyString(value.resolvedCommand, 4096) &&
      value.command === value.resolvedCommand &&
      isBoundedNonEmptyString(value.executable, 1024) &&
      Array.isArray(value.args) &&
      value.args.length > 0 &&
      value.args.length <= 32 &&
      value.args.every((argument) => isBoundedNonEmptyString(argument, 4096)) &&
      isBoundedNonEmptyString(value.script, 256);
    if (!activeCommand) return false;
    if (status === "passed") {
      return value.executed === true && value.exitCode === 0 && value.signal === null;
    }
    if (value.reason === "step timeout" || value.reason === "aggregate timeout") {
      return value.exitCode === null && value.signal === "SIGTERM";
    }
    if (value.reason === "spawn failure") {
      return value.executed === true && value.exitCode === null && value.signal === null;
    }
    if (value.reason === "cancelled") {
      return value.executed === false && value.exitCode === null && value.signal === null;
    }
    return (
      value.executed === true &&
      ((typeof value.exitCode === "number" && value.exitCode !== 0) || value.signal !== null)
    );
  }
  return (
    value.executed === false &&
    value.exitCode === null &&
    value.signal === null &&
    value.durationMs === 0 &&
    isEmptyChunk(value.stdout) &&
    isEmptyChunk(value.stderr) &&
    isBoundedString(value.reason, 1024)
  );
}

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
  const steps = value.perStep.filter(isStep);
  if (steps.length !== value.perStep.length) return false;
  const expected = steps.some((step) => step.status === "failed" || step.status === "not-run")
    ? "failed"
    : steps.some((step) => step.status === "omitted")
      ? "incomplete"
      : "passed";
  return steps.every((step) => step.verdict === step.status) && value.verdict === expected;
}

export function isVerifyEvidenceRecord(
  value: unknown,
  logicalRequestKey?: string,
): value is VerifyEvidenceRecord {
  if (!isRecord(value)) return false;
  return (
    value.cacheFormatVersion === VERIFY_CACHE_FORMAT_VERSION &&
    isBoundedString(value.key, 256) &&
    (logicalRequestKey === undefined || value.key === logicalRequestKey) &&
    isBoundedString(value.ref, 128) &&
    value.ref === `vr_${value.key.slice(0, 24)}` &&
    isBoundedString(value.projectPath, 4096) &&
    isAbsolute(value.projectPath) &&
    (value.repositoryState === undefined ||
      (isRepositoryState(value.repositoryState) &&
        value.repositoryState.workingDirectory === value.projectPath)) &&
    (value.provenance === undefined || isProvenance(value.provenance)) &&
    (value.publication === undefined || isPublication(value.publication)) &&
    (value.mutating === undefined || typeof value.mutating === "boolean") &&
    (value.concurrentExecutions === undefined ||
      isBoundedInteger(value.concurrentExecutions, 0, 256)) &&
    (value.stateDrift === undefined || typeof value.stateDrift === "boolean") &&
    (value.sharedExecution === undefined || typeof value.sharedExecution === "boolean") &&
    Array.isArray(value.resolvedCommands) &&
    value.resolvedCommands.length > 0 &&
    value.resolvedCommands.length <= VERIFY_CACHE_MAX_COMMANDS &&
    value.resolvedCommands.every((command) => isBoundedString(command, 4096)) &&
    Array.isArray(value.perStep) &&
    value.perStep.length === VERIFY_CACHE_MAX_STEPS &&
    value.perStep.every(isStep) &&
    value.perStep.every((step, index) => isStep(step) && step.phase === VERIFY_PHASES[index]) &&
    (value.verdict === "passed" || value.verdict === "failed" || value.verdict === "incomplete") &&
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

function isVerifyRefAlias(
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
