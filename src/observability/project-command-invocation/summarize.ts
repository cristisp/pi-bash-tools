import type { ResultCategory } from "../../tools/errors.ts";
import type { ProjectCommandCacheDecision } from "../../tools/project-command/cache.ts";
import type { ProjectCommandExecutionStatus } from "../../tools/project-command/execution.ts";
import { EXTENSION_VERSION } from "../../version.ts";
import { OBSERVABILITY_MAX_METADATA_NUMBER, boundedIdentifier, boundedNumber } from "../bounded.ts";

const MAX_METADATA_NUMBER = OBSERVABILITY_MAX_METADATA_NUMBER;
import {
  MEASUREMENT_KEYS,
  createMeasurementState,
  measurementsFromStates,
  validCacheDecision,
  validCategory,
  validStatus,
  type MutableMeasurementState,
} from "./bound.ts";
import {
  PROJECT_COMMAND_SUMMARY_FORMAT_VERSION,
  PROJECT_COMMAND_SUMMARY_MAX_BYTES,
  PROJECT_COMMAND_SUMMARY_MAX_COUNT,
  PROJECT_COMMAND_SUMMARY_MAX_SCHEMA_HASHES,
  type ProjectCommandInvocationRecord,
  type ProjectCommandInvocationSummary,
} from "./types.ts";

type MutableProjectCommandInvocationCacheDecisionCounts = Record<
  ProjectCommandCacheDecision,
  number
>;
type MutableProjectCommandInvocationResultCategoryCounts = Record<ResultCategory, number>;
type MutableProjectCommandInvocationProcessStatusCounts = Record<
  ProjectCommandExecutionStatus,
  number
>;

export interface ProjectCommandInvocationSummaryAccumulator {
  readonly sessionId: string;
  invocationCount: number;
  readonly cacheDecisions: MutableProjectCommandInvocationCacheDecisionCounts;
  repeatedUnchangedRequests: number;
  readonly resultCategories: MutableProjectCommandInvocationResultCategoryCounts;
  readonly processStatuses: MutableProjectCommandInvocationProcessStatusCounts;
  durationMs: number;
  executionDurationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncations: number;
  stderrTruncations: number;
  readonly measurementsBefore: MutableMeasurementState;
  readonly measurementsAfter: MutableMeasurementState;
  readonly schemaHashes: Set<string>;
}

function createCacheDecisionCounts(): MutableProjectCommandInvocationCacheDecisionCounts {
  return { miss: 0, hit: 0, forced: 0, ineligible: 0, invalidated: 0 };
}

function createResultCategoryCounts(): MutableProjectCommandInvocationResultCategoryCounts {
  return {
    PASS: 0,
    INVALID_REQUEST: 0,
    IMPLEMENTATION_FAILURE: 0,
    TEST_FAILURE: 0,
    FORMAT_FAILURE: 0,
    LINT_FAILURE: 0,
    TYPE_CHECK_FAILURE: 0,
    RESOLUTION_FAILURE: 0,
    POLICY_FAILURE: 0,
    ENVIRONMENT_FAILURE: 0,
    TIMEOUT: 0,
    SPAWN_FAILURE: 0,
    CANCELLED: 0,
    BLOCKED: 0,
  };
}

function createProcessStatusCounts(): MutableProjectCommandInvocationProcessStatusCounts {
  return { success: 0, nonzero: 0, timeout: 0, "spawn-failure": 0, cancelled: 0 };
}

export function createSummaryAccumulator(
  sessionId: string,
): ProjectCommandInvocationSummaryAccumulator {
  return {
    sessionId: boundedIdentifier(sessionId),
    invocationCount: 0,
    cacheDecisions: createCacheDecisionCounts(),
    repeatedUnchangedRequests: 0,
    resultCategories: createResultCategoryCounts(),
    processStatuses: createProcessStatusCounts(),
    durationMs: 0,
    executionDurationMs: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncations: 0,
    stderrTruncations: 0,
    measurementsBefore: createMeasurementState(),
    measurementsAfter: createMeasurementState(),
    schemaHashes: new Set(),
  };
}

function incrementSummaryCount(
  counts: Record<string, number>,
  key: string,
  amount = 1,
  maximum = PROJECT_COMMAND_SUMMARY_MAX_COUNT,
): void {
  const increment = boundedNumber(amount);
  counts[key] = Math.min(maximum, counts[key] + increment);
}

export function addSummaryRecord(
  accumulator: ProjectCommandInvocationSummaryAccumulator,
  record: ProjectCommandInvocationRecord,
): void {
  accumulator.invocationCount = Math.min(
    PROJECT_COMMAND_SUMMARY_MAX_COUNT,
    accumulator.invocationCount + 1,
  );
  incrementSummaryCount(accumulator.cacheDecisions, validCacheDecision(record.cacheDecision));
  if (record.cacheDecision === "hit" && record.reused) {
    accumulator.repeatedUnchangedRequests = Math.min(
      PROJECT_COMMAND_SUMMARY_MAX_COUNT,
      accumulator.repeatedUnchangedRequests + 1,
    );
  }

  const resultCategory = validCategory(record.resultCategory);
  incrementSummaryCount(accumulator.resultCategories, resultCategory);
  if (record.status !== undefined) {
    const status = validStatus(record.status);
    if (status !== undefined) incrementSummaryCount(accumulator.processStatuses, status);
  }

  accumulator.durationMs = Math.min(
    MAX_METADATA_NUMBER,
    accumulator.durationMs + boundedNumber(record.durationMs),
  );
  accumulator.executionDurationMs = Math.min(
    MAX_METADATA_NUMBER,
    accumulator.executionDurationMs + boundedNumber(record.executionDurationMs),
  );
  accumulator.stdoutBytes = Math.min(
    MAX_METADATA_NUMBER,
    accumulator.stdoutBytes + boundedNumber(record.output.stdout.totalBytes),
  );
  accumulator.stderrBytes = Math.min(
    MAX_METADATA_NUMBER,
    accumulator.stderrBytes + boundedNumber(record.output.stderr.totalBytes),
  );
  if (record.output.stdout.truncated) {
    accumulator.stdoutTruncations = Math.min(
      PROJECT_COMMAND_SUMMARY_MAX_COUNT,
      accumulator.stdoutTruncations + 1,
    );
  }
  if (record.output.stderr.truncated) {
    accumulator.stderrTruncations = Math.min(
      PROJECT_COMMAND_SUMMARY_MAX_COUNT,
      accumulator.stderrTruncations + 1,
    );
  }

  const measurements = record.measurements;
  if (measurements !== undefined) {
    for (const key of MEASUREMENT_KEYS) {
      const pair = measurements[key];
      if (pair === undefined) continue;
      accumulator.measurementsBefore[key] = Math.min(
        MAX_METADATA_NUMBER,
        accumulator.measurementsBefore[key] + boundedNumber(pair.before),
      );
      accumulator.measurementsAfter[key] = Math.min(
        MAX_METADATA_NUMBER,
        accumulator.measurementsAfter[key] + boundedNumber(pair.after),
      );
    }
  }

  if (
    accumulator.schemaHashes.size < PROJECT_COMMAND_SUMMARY_MAX_SCHEMA_HASHES &&
    typeof record.schemaHash === "string"
  ) {
    accumulator.schemaHashes.add(boundedIdentifier(record.schemaHash));
  }
}

function freezeSummary(summary: ProjectCommandInvocationSummary): ProjectCommandInvocationSummary {
  return Object.freeze({
    ...summary,
    cacheDecisions: Object.freeze({ ...summary.cacheDecisions }),
    resultCategories: Object.freeze({ ...summary.resultCategories }),
    processStatuses: Object.freeze({ ...summary.processStatuses }),
    outputBytes: Object.freeze({ ...summary.outputBytes }),
    truncationCounts: Object.freeze({ ...summary.truncationCounts }),
    schemaHashes: Object.freeze([...summary.schemaHashes]),
  });
}

export function summaryFromAccumulator(
  accumulator: ProjectCommandInvocationSummaryAccumulator,
): ProjectCommandInvocationSummary {
  const summary = freezeSummary({
    summaryFormatVersion: PROJECT_COMMAND_SUMMARY_FORMAT_VERSION,
    extensionVersion: boundedIdentifier(EXTENSION_VERSION),
    sessionId: accumulator.sessionId,
    invocationCount: accumulator.invocationCount,
    cacheDecisions: accumulator.cacheDecisions,
    repeatedUnchangedRequests: accumulator.repeatedUnchangedRequests,
    resultCategories: accumulator.resultCategories,
    processStatuses: accumulator.processStatuses,
    durationMs: accumulator.durationMs,
    executionDurationMs: accumulator.executionDurationMs,
    outputBytes: {
      stdout: accumulator.stdoutBytes,
      stderr: accumulator.stderrBytes,
    },
    truncationCounts: {
      stdout: accumulator.stdoutTruncations,
      stderr: accumulator.stderrTruncations,
    },
    measurements: measurementsFromStates(
      accumulator.measurementsBefore,
      accumulator.measurementsAfter,
    ),
    schemaHashes: [...accumulator.schemaHashes],
  });

  try {
    if (Buffer.byteLength(JSON.stringify(summary), "utf8") <= PROJECT_COMMAND_SUMMARY_MAX_BYTES) {
      return summary;
    }
  } catch {
    // Return the minimal bounded shape below.
  }
  return freezeSummary({ ...summary, schemaHashes: [] });
}

/** Aggregate invocation records into a bounded, privacy-safe session summary. */
export function summarizeProjectCommandInvocations(
  records: readonly ProjectCommandInvocationRecord[],
  sessionId = records[0]?.sessionId,
): ProjectCommandInvocationSummary | undefined {
  if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
  const accumulator = createSummaryAccumulator(sessionId);
  const normalizedSessionId = boundedIdentifier(sessionId);
  for (const record of records) {
    if (boundedIdentifier(record.sessionId) !== normalizedSessionId) continue;
    addSummaryRecord(accumulator, record);
  }
  return summaryFromAccumulator(accumulator);
}
