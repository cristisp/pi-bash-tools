import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { hashCanonicalJson } from "./canonical-json.ts";
import { RESULT_CATEGORIES, type ResultCategory } from "../tools/errors.ts";
import { EXTENSION_VERSION } from "../version.ts";
import type { ProjectCommandCacheDecision } from "../tools/project-command/cache.ts";
import type { ProjectCommandExecutionStatus } from "../tools/project-command/execution.ts";

const PROJECT_COMMAND_INVOCATION_FORMAT_VERSION = 1 as const;
export const PROJECT_COMMAND_INVOCATION_ENTRY_TYPE =
  "bash-tools.project-command-invocation" as const;
export const PROJECT_COMMAND_INVOCATION_MAX_BYTES = 8 * 1024;
const PROJECT_COMMAND_SUMMARY_FORMAT_VERSION = 1 as const;
export const PROJECT_COMMAND_SUMMARY_ENTRY_TYPE = "bash-tools.project-command-summary" as const;
export const PROJECT_COMMAND_SUMMARY_MAX_BYTES = 8 * 1024;
export const PROJECT_COMMAND_SUMMARY_MAX_COUNT = 1_000_000;
export const PROJECT_COMMAND_SUMMARY_MAX_SCHEMA_HASHES = 32;

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_PARAMETER_KEYS = 16;
const MAX_PARAMETER_ITEMS = 16;
const MAX_PARAMETER_LENGTH = 1_000_000;
const MAX_METADATA_NUMBER = 9_999_999_999;

const PROJECT_COMMAND_INVOCATION_REASONS = [
  "executed-after-cache-miss",
  "reused-cache-hit",
  "executed-forced-cache-bypass",
  "executed-cache-ineligible",
  "executed-after-cache-invalidation",
  "invalid-request",
  "resolution-failure",
  "policy-failure",
  "execution-failure",
  "cancelled",
  "preparation-failure",
] as const;

export type ProjectCommandInvocationReason = (typeof PROJECT_COMMAND_INVOCATION_REASONS)[number];

export interface ProjectCommandInvocationStreamMetadata {
  readonly truncated: boolean;
  readonly totalBytes: number;
  readonly totalLines: number;
}

export interface ProjectCommandInvocationOutputMetadata {
  readonly stdout: ProjectCommandInvocationStreamMetadata;
  readonly stderr: ProjectCommandInvocationStreamMetadata;
}

/** Values in this map are either bounded non-sensitive values or redaction metadata. */
export type ProjectCommandInvocationParameters = Readonly<Record<string, unknown>>;

export interface ProjectCommandInvocationRecordInput {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly schemaHash: string;
  readonly commandId?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  /** Already-redacted parameters for callers that must not pass raw arguments to a recorder. */
  readonly redactedParameters?: ProjectCommandInvocationParameters;
  readonly resultCategory: ResultCategory;
  readonly status?: ProjectCommandExecutionStatus;
  readonly executed: boolean;
  readonly reason: ProjectCommandInvocationReason;
  readonly cacheDecision: ProjectCommandCacheDecision;
  readonly forced: boolean;
  readonly reused: boolean;
  readonly durationMs: number;
  readonly executionDurationMs: number;
  readonly output?: ProjectCommandInvocationOutputMetadata;
  readonly producerScope?: "session" | "flow";
}

export interface ProjectCommandInvocationRecord {
  readonly invocationFormatVersion: typeof PROJECT_COMMAND_INVOCATION_FORMAT_VERSION;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly schemaHash: string;
  readonly commandId?: string;
  readonly parameters?: ProjectCommandInvocationParameters;
  readonly resultCategory: ResultCategory;
  readonly status?: ProjectCommandExecutionStatus;
  readonly executed: boolean;
  readonly reason: ProjectCommandInvocationReason;
  readonly cacheDecision: ProjectCommandCacheDecision;
  readonly forced: boolean;
  readonly reused: boolean;
  readonly durationMs: number;
  readonly executionDurationMs: number;
  readonly output: ProjectCommandInvocationOutputMetadata;
  readonly producerScope?: "session" | "flow";
}

export type ProjectCommandInvocationRecorder = (record: ProjectCommandInvocationRecord) => void;

export interface ProjectCommandInvocationCacheDecisionCounts {
  readonly miss: number;
  readonly hit: number;
  readonly forced: number;
  readonly ineligible: number;
  readonly invalidated: number;
}

export type ProjectCommandInvocationResultCategoryCounts = Readonly<Record<ResultCategory, number>>;

export type ProjectCommandInvocationProcessStatusCounts = Readonly<
  Record<ProjectCommandExecutionStatus, number>
>;

export interface ProjectCommandInvocationSummary {
  readonly summaryFormatVersion: typeof PROJECT_COMMAND_SUMMARY_FORMAT_VERSION;
  readonly extensionVersion: string;
  readonly sessionId: string;
  readonly invocationCount: number;
  readonly cacheDecisions: ProjectCommandInvocationCacheDecisionCounts;
  readonly repeatedUnchangedRequests: number;
  readonly resultCategories: ProjectCommandInvocationResultCategoryCounts;
  readonly processStatuses: ProjectCommandInvocationProcessStatusCounts;
  readonly durationMs: number;
  readonly executionDurationMs: number;
  readonly outputBytes: {
    readonly stdout: number;
    readonly stderr: number;
  };
  readonly truncationCounts: {
    readonly stdout: number;
    readonly stderr: number;
  };
  /** The first distinct schema hashes observed, capped for bounded persistence. */
  readonly schemaHashes: readonly string[];
}

export interface ProjectCommandInvocationLifecycleContext {
  readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
}

export interface ProjectCommandInvocationSessionRecorder {
  readonly invocationRecorder: ProjectCommandInvocationRecorder;
  readonly onSessionStart: (
    event: Pick<SessionStartEvent, "reason">,
    context: ProjectCommandInvocationLifecycleContext,
  ) => void;
  readonly onSessionShutdown: (
    event: Pick<SessionShutdownEvent, "reason">,
    context: ProjectCommandInvocationLifecycleContext,
  ) => void;
}

export type ProjectCommandInvocationAPI = Pick<ExtensionAPI, "appendEntry">;

function boundedIdentifier(value: string): string {
  if (value.length <= MAX_IDENTIFIER_LENGTH) return value;
  return `${value.slice(0, MAX_IDENTIFIER_LENGTH - 1)}…`;
}

function boundedNumber(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), MAX_METADATA_NUMBER);
}

function boundedOutput(
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

function validCategory(value: ResultCategory): ResultCategory {
  return RESULT_CATEGORIES.includes(value) ? value : "IMPLEMENTATION_FAILURE";
}

function validCacheDecision(value: ProjectCommandCacheDecision): ProjectCommandCacheDecision {
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

function validReason(value: ProjectCommandInvocationReason): ProjectCommandInvocationReason {
  return PROJECT_COMMAND_INVOCATION_REASONS.includes(value) ? value : "preparation-failure";
}

function validStatus(
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

function boundedRecord(record: ProjectCommandInvocationRecord): ProjectCommandInvocationRecord {
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
    output: record.output,
  });
}

/** Build a compact, persistence-safe invocation record without command output or paths. */
export function buildProjectCommandInvocationRecord(
  input: ProjectCommandInvocationRecordInput,
): ProjectCommandInvocationRecord {
  const parameters =
    input.redactedParameters ??
    (input.parameters === undefined ? undefined : redactProjectCommandParameters(input.parameters));
  const record: ProjectCommandInvocationRecord = {
    invocationFormatVersion: PROJECT_COMMAND_INVOCATION_FORMAT_VERSION,
    sessionId: boundedIdentifier(input.sessionId),
    toolCallId: boundedIdentifier(input.toolCallId),
    schemaHash: boundedIdentifier(input.schemaHash),
    ...(input.commandId === undefined ? {} : { commandId: boundedIdentifier(input.commandId) }),
    ...(parameters === undefined ? {} : { parameters }),
    resultCategory: validCategory(input.resultCategory),
    ...(validStatus(input.status) === undefined ? {} : { status: validStatus(input.status) }),
    executed: input.executed,
    reason: validReason(input.reason),
    cacheDecision: validCacheDecision(input.cacheDecision),
    forced: input.forced,
    reused: input.reused,
    durationMs: boundedNumber(input.durationMs),
    executionDurationMs: boundedNumber(input.executionDurationMs),
    output: boundedOutput(input.output),
    ...(input.producerScope === undefined ? {} : { producerScope: input.producerScope }),
  };
  return boundedRecord(record);
}

type MutableProjectCommandInvocationCacheDecisionCounts = Record<
  ProjectCommandCacheDecision,
  number
>;
type MutableProjectCommandInvocationResultCategoryCounts = Record<ResultCategory, number>;
type MutableProjectCommandInvocationProcessStatusCounts = Record<
  ProjectCommandExecutionStatus,
  number
>;

interface ProjectCommandInvocationSummaryAccumulator {
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

function createSummaryAccumulator(sessionId: string): ProjectCommandInvocationSummaryAccumulator {
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

function addSummaryRecord(
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

function summaryFromAccumulator(
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

function contextSessionId(context: ProjectCommandInvocationLifecycleContext): string | undefined {
  try {
    const sessionId = context.sessionManager.getSessionId();
    return typeof sessionId === "string" && sessionId.length > 0
      ? boundedIdentifier(sessionId)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keep the existing per-invocation entries while aggregating only the active session in memory.
 * The accumulator is intentionally discarded on shutdown and is never restored from a session.
 */
export function createProjectCommandInvocationSessionRecorder(
  api: ProjectCommandInvocationAPI,
): ProjectCommandInvocationSessionRecorder {
  const invocationRecorder = createProjectCommandInvocationRecorder(api);
  let activeSessionId: string | undefined;
  let accumulator: ProjectCommandInvocationSummaryAccumulator | undefined;
  let shutdownFlushed = false;

  const onSessionStart = (
    _event: Pick<SessionStartEvent, "reason">,
    context: ProjectCommandInvocationLifecycleContext,
  ): void => {
    activeSessionId = contextSessionId(context);
    accumulator =
      activeSessionId === undefined ? undefined : createSummaryAccumulator(activeSessionId);
    shutdownFlushed = false;
  };

  const onSessionShutdown = (
    _event: Pick<SessionShutdownEvent, "reason">,
    context: ProjectCommandInvocationLifecycleContext,
  ): void => {
    if (shutdownFlushed) return;
    shutdownFlushed = true;
    const sessionId = activeSessionId;
    const currentSessionId = contextSessionId(context);
    if (sessionId !== undefined && sessionId === currentSessionId && accumulator !== undefined) {
      try {
        api.appendEntry(PROJECT_COMMAND_SUMMARY_ENTRY_TYPE, summaryFromAccumulator(accumulator));
      } catch {
        // Summary persistence must never affect session shutdown or command results.
      }
    }
    activeSessionId = undefined;
    accumulator = undefined;
  };

  const record: ProjectCommandInvocationRecorder = (invocation) => {
    invocationRecorder(invocation);
    if (activeSessionId === undefined || invocation.sessionId !== activeSessionId) return;
    if (accumulator === undefined) accumulator = createSummaryAccumulator(activeSessionId);
    try {
      addSummaryRecord(accumulator, invocation);
    } catch {
      // Aggregation is observational and must not affect command execution.
    }
  };

  return Object.freeze({ invocationRecorder: record, onSessionStart, onSessionShutdown });
}

/** Create a best-effort recorder backed by Pi's session custom-entry API. */
export function createProjectCommandInvocationRecorder(
  api: ProjectCommandInvocationAPI,
): ProjectCommandInvocationRecorder {
  return (record) => {
    try {
      api.appendEntry(PROJECT_COMMAND_INVOCATION_ENTRY_TYPE, record);
    } catch {
      // Observability must never change a command result or error.
    }
  };
}

/** Invoke an injected recorder without allowing observability failures to escape. */
export function recordProjectCommandInvocation(
  recorder: ProjectCommandInvocationRecorder | undefined,
  input: ProjectCommandInvocationRecordInput,
): void {
  if (recorder === undefined) return;
  try {
    recorder(buildProjectCommandInvocationRecord(input));
  } catch {
    // A test or alternate recorder is also best effort by contract.
  }
}
