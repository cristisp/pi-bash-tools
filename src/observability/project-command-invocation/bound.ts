import { RESULT_CATEGORIES, type ResultCategory } from "../../tools/errors.ts";
import type { ProjectCommandCacheDecision } from "../../tools/project-command/cache.ts";
import type { ProjectCommandExecutionStatus } from "../../tools/project-command/execution.ts";
import { boundedIdentifier, boundedLookupOutcome, boundedNumber } from "../bounded.ts";
import { hashCanonicalJson } from "../canonical-json.ts";
import { measurementPair } from "../measurements.ts";
import {
  PROJECT_COMMAND_INVOCATION_FORMAT_VERSION,
  PROJECT_COMMAND_INVOCATION_MAX_BYTES,
  PROJECT_COMMAND_INVOCATION_REASONS,
  type ProjectCommandInvocationLookupMetadata,
  type ProjectCommandInvocationLookupOutcome,
  type ProjectCommandInvocationMeasurementState,
  type ProjectCommandInvocationMeasurements,
  type ProjectCommandInvocationOutputMetadata,
  type ProjectCommandInvocationParameters,
  type ProjectCommandInvocationPublicationMetadata,
  type ProjectCommandInvocationReason,
  type ProjectCommandInvocationRecord,
  type ProjectCommandInvocationRepositoryStateMetadata,
  type ProjectCommandInvocationStreamMetadata,
} from "./types.ts";

const MAX_PARAMETER_KEYS = 16;
const MAX_PARAMETER_ITEMS = 16;
const MAX_PARAMETER_LENGTH = 1_000_000;

export const MEASUREMENT_KEYS = [
  "cacheReuse",
  "cacheInvalidation",
  "truncation",
  "repeatedRequests",
] as const satisfies readonly (keyof ProjectCommandInvocationMeasurementState)[];

export type MeasurementKey = (typeof MEASUREMENT_KEYS)[number];
export type MutableMeasurementState = Record<MeasurementKey, number>;

/** Clamp an untrusted lookup outcome string to the bounded persisted enum. */
export function projectCommandInvocationLookupOutcome(
  value: string | undefined,
): ProjectCommandInvocationLookupOutcome | undefined {
  return boundedLookupOutcome(value);
}

export function boundedOutput(
  output: ProjectCommandInvocationOutputMetadata | undefined,
): ProjectCommandInvocationOutputMetadata {
  const stream = (
    value: ProjectCommandInvocationStreamMetadata | undefined,
  ): ProjectCommandInvocationStreamMetadata => ({
    truncated: value?.truncated === true,
    totalBytes: boundedNumber(value?.totalBytes ?? 0),
    totalLines: boundedNumber(value?.totalLines ?? 0),
  });
  return {
    stdout: stream(output?.stdout),
    stderr: stream(output?.stderr),
  };
}

export function createMeasurementState(): MutableMeasurementState {
  return {
    cacheReuse: 0,
    cacheInvalidation: 0,
    truncation: 0,
    repeatedRequests: 0,
  };
}

export function measurementsFromStates(
  before: ProjectCommandInvocationMeasurementState,
  after: ProjectCommandInvocationMeasurementState,
): ProjectCommandInvocationMeasurements {
  return Object.freeze({
    cacheReuse: measurementPair(before.cacheReuse, after.cacheReuse),
    cacheInvalidation: measurementPair(before.cacheInvalidation, after.cacheInvalidation),
    truncation: measurementPair(before.truncation, after.truncation),
    repeatedRequests: measurementPair(before.repeatedRequests, after.repeatedRequests),
  });
}

export function boundedMeasurements(
  value: ProjectCommandInvocationMeasurements | undefined,
): ProjectCommandInvocationMeasurements | undefined {
  if (value === undefined) return undefined;
  const before = createMeasurementState();
  const after = createMeasurementState();
  for (const key of MEASUREMENT_KEYS) {
    before[key] = boundedNumber(value[key].before);
    after[key] = boundedNumber(value[key].after);
  }
  return measurementsFromStates(before, after);
}

export function boundedState(
  value: ProjectCommandInvocationRepositoryStateMetadata | undefined,
): ProjectCommandInvocationRepositoryStateMetadata | undefined {
  if (value === undefined) return undefined;
  return {
    repositoryIdentity: boundedIdentifier(value.repositoryIdentity),
    head: boundedIdentifier(value.head),
    dirtyFilesDigest: boundedIdentifier(value.dirtyFilesDigest),
    ...(value.readable === undefined ? {} : { readable: value.readable }),
    ...(value.stateMatchesCurrent === undefined
      ? {}
      : { stateMatchesCurrent: value.stateMatchesCurrent }),
  };
}

export function boundedLookup(
  value: ProjectCommandInvocationLookupMetadata | undefined,
): ProjectCommandInvocationLookupMetadata | undefined {
  if (value === undefined || !value.attempted) return undefined;
  const outcome = projectCommandInvocationLookupOutcome(value.outcome);
  return {
    attempted: true,
    success: value.success,
    ...(value.failure === undefined ? {} : { failure: boundedIdentifier(value.failure) }),
    ...(outcome === undefined ? {} : { outcome }),
  };
}

export function boundedPublication(
  value: ProjectCommandInvocationPublicationMetadata | undefined,
): ProjectCommandInvocationPublicationMetadata | undefined {
  if (value === undefined) return undefined;
  return {
    scope: value.scope === "flow" ? "flow" : "root",
    published: value.published,
    ...(value.flowId === undefined ? {} : { flowId: boundedIdentifier(value.flowId) }),
    ...(value.error === undefined ? {} : { error: boundedIdentifier(value.error) }),
  };
}

export function boundedCoercions(
  value: readonly string[] | undefined,
): readonly string[] | undefined {
  if (value === undefined || value.length === 0) return undefined;
  return Object.freeze(
    value.slice(0, MAX_PARAMETER_ITEMS).map((entry) => boundedIdentifier(entry)),
  );
}

function safeHash(value: unknown): string {
  try {
    return hashCanonicalJson(value);
  } catch {
    return hashCanonicalJson({ type: typeof value });
  }
}

function boundedParameterCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), MAX_PARAMETER_ITEMS);
}

function redactParameterValue(value: unknown): unknown {
  if (typeof value === "string") {
    return {
      hash: safeHash(value),
      length: Math.min(value.length, MAX_PARAMETER_LENGTH),
    };
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : { type: "number" };
  }
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_PARAMETER_ITEMS).map((item) => safeHash(item));
    return {
      count: boundedParameterCount(value.length),
      hashes: items,
    };
  }
  return { hash: safeHash(value), type: typeof value };
}

/** Redact request argument values while retaining bounded information for analysis. */
export function redactProjectCommandParameters(
  parameters: Readonly<Record<string, unknown>>,
): ProjectCommandInvocationParameters {
  const entries = Object.keys(parameters)
    .sort()
    .slice(0, MAX_PARAMETER_KEYS)
    .map((key) => {
      if ((key === "commandId" || key === "variant") && typeof parameters[key] === "string") {
        return [key, boundedIdentifier(parameters[key])] as const;
      }
      return [boundedIdentifier(key), redactParameterValue(parameters[key])] as const;
    });
  return Object.freeze(Object.fromEntries(entries));
}

export function validCategory(value: ResultCategory): ResultCategory {
  return RESULT_CATEGORIES.includes(value) ? value : "IMPLEMENTATION_FAILURE";
}

export function validCacheDecision(
  value: ProjectCommandCacheDecision,
): ProjectCommandCacheDecision {
  switch (value) {
    case "miss":
    case "hit":
    case "forced":
    case "ineligible":
    case "invalidated":
      return value;
    default:
      return "ineligible";
  }
}

export function validReason(value: ProjectCommandInvocationReason): ProjectCommandInvocationReason {
  return PROJECT_COMMAND_INVOCATION_REASONS.includes(value) ? value : "preparation-failure";
}

export function validStatus(
  value: ProjectCommandExecutionStatus | undefined,
): ProjectCommandExecutionStatus | undefined {
  switch (value) {
    case "success":
    case "nonzero":
    case "timeout":
    case "spawn-failure":
    case "cancelled":
      return value;
    default:
      return undefined;
  }
}

export function boundedRecord(
  record: ProjectCommandInvocationRecord,
): ProjectCommandInvocationRecord {
  // All fields are independently bounded above. Keep a final guard here so a future
  // field cannot accidentally turn this persistence format into an unbounded record.
  try {
    const serialized = JSON.stringify(record);
    if (
      serialized !== undefined &&
      Buffer.byteLength(serialized, "utf8") <= PROJECT_COMMAND_INVOCATION_MAX_BYTES
    ) {
      return Object.freeze(record);
    }
  } catch {
    // Fall through to the minimal shape below.
  }
  return Object.freeze({
    invocationFormatVersion: PROJECT_COMMAND_INVOCATION_FORMAT_VERSION,
    sessionId: boundedIdentifier(record.sessionId),
    toolCallId: boundedIdentifier(record.toolCallId),
    schemaHash: boundedIdentifier(record.schemaHash),
    resultCategory: record.resultCategory,
    executed: record.executed,
    reason: record.reason,
    cacheDecision: record.cacheDecision,
    forced: record.forced,
    reused: record.reused,
    durationMs: record.durationMs,
    executionDurationMs: record.executionDurationMs,
    ...(record.preparationDurationMs === undefined
      ? {}
      : { preparationDurationMs: record.preparationDurationMs }),
    ...(record.authorizationDurationMs === undefined
      ? {}
      : { authorizationDurationMs: record.authorizationDurationMs }),
    ...(record.queueDurationMs === undefined ? {} : { queueDurationMs: record.queueDurationMs }),
    output: record.output,
    ...(record.measurements === undefined ? {} : { measurements: record.measurements }),
    ...(record.flowId === undefined ? {} : { flowId: record.flowId }),
    ...(record.delegationId === undefined ? {} : { delegationId: record.delegationId }),
    ...(record.role === undefined ? {} : { role: record.role }),
    ...(record.ref === undefined ? {} : { ref: record.ref }),
    ...(record.repositoryState === undefined ? {} : { repositoryState: record.repositoryState }),
    ...(record.verdict === undefined ? {} : { verdict: record.verdict }),
    ...(record.mutating === undefined ? {} : { mutating: record.mutating }),
    ...(record.publication === undefined ? {} : { publication: record.publication }),
    ...(record.lookup === undefined ? {} : { lookup: record.lookup }),
    ...(record.coercions === undefined ? {} : { coercions: record.coercions }),
    ...(record.concurrentExecutions === undefined
      ? {}
      : { concurrentExecutions: record.concurrentExecutions }),
    ...(record.stateDrift === undefined ? {} : { stateDrift: record.stateDrift }),
    ...(record.sharedExecution === undefined ? {} : { sharedExecution: record.sharedExecution }),
    ...(record.aggregate === undefined ? {} : { aggregate: record.aggregate }),
    ...(record.retryable === undefined ? {} : { retryable: record.retryable }),
    ...(record.missingPhase === undefined ? {} : { missingPhase: record.missingPhase }),
    ...(record.missingScript === undefined ? {} : { missingScript: record.missingScript }),
  });
}
