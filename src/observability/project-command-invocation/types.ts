import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import type { ResultCategory } from "../../tools/errors.ts";
import type { ProjectCommandCacheDecision } from "../../tools/project-command/cache.ts";
import type { ProjectCommandExecutionStatus } from "../../tools/project-command/execution.ts";
import type { MeasurementPair } from "../measurements.ts";

export const PROJECT_COMMAND_INVOCATION_FORMAT_VERSION = 1 as const;
export const PROJECT_COMMAND_INVOCATION_ENTRY_TYPE =
  "bash-tools.project-command-invocation" as const;
export const PROJECT_COMMAND_INVOCATION_MAX_BYTES = 8 * 1024;
export const PROJECT_COMMAND_SUMMARY_FORMAT_VERSION = 1 as const;
export const PROJECT_COMMAND_SUMMARY_ENTRY_TYPE = "bash-tools.project-command-summary" as const;
export const PROJECT_COMMAND_SUMMARY_MAX_BYTES = 8 * 1024;
export const PROJECT_COMMAND_SUMMARY_MAX_COUNT = 1_000_000;
export const PROJECT_COMMAND_SUMMARY_MAX_SCHEMA_HASHES = 32;

export const PROJECT_COMMAND_INVOCATION_REASONS = [
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
  "lookup-failure",
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

export interface ProjectCommandInvocationMeasurementState {
  readonly cacheReuse: number;
  readonly cacheInvalidation: number;
  readonly truncation: number;
  readonly repeatedRequests: number;
}

export interface ProjectCommandInvocationMeasurements {
  readonly cacheReuse: MeasurementPair;
  readonly cacheInvalidation: MeasurementPair;
  readonly truncation: MeasurementPair;
  readonly repeatedRequests: MeasurementPair;
}

export interface ProjectCommandInvocationRepositoryStateMetadata {
  readonly repositoryIdentity: string;
  readonly head: string;
  readonly dirtyFilesDigest: string;
  readonly readable?: boolean;
  readonly stateMatchesCurrent?: boolean;
}

export interface ProjectCommandInvocationPublicationMetadata {
  readonly scope: "root" | "flow";
  readonly flowId?: string;
  readonly published: boolean;
  readonly error?: string;
}

export type ProjectCommandInvocationLookupOutcome =
  | "success"
  | "not-found"
  | "unauthorized-flow"
  | "corrupt";

export interface ProjectCommandInvocationLookupMetadata {
  readonly attempted: boolean;
  readonly success: boolean;
  readonly failure?: string;
  readonly outcome?: string;
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
  /** Time from tool entry to the authorization mark, or to invocation end on a preparation failure. */
  readonly preparationDurationMs?: number;
  /** Time spent inside the single authorization call, including any confirmation prompt wait. */
  readonly authorizationDurationMs?: number;
  /** Time a single-flight follower waited for the in-flight execution to settle. */
  readonly queueDurationMs?: number;
  readonly output?: ProjectCommandInvocationOutputMetadata;
  readonly measurements?: ProjectCommandInvocationMeasurements;
  readonly producerScope?: "session" | "flow";
  readonly flowId?: string;
  readonly delegationId?: string;
  readonly role?: string;
  readonly ref?: string;
  readonly repositoryState?: ProjectCommandInvocationRepositoryStateMetadata;
  readonly verdict?: "passed" | "failed" | "incomplete";
  readonly mutating?: boolean;
  readonly publication?: ProjectCommandInvocationPublicationMetadata;
  readonly lookup?: ProjectCommandInvocationLookupMetadata;
  readonly coercions?: readonly string[];
  readonly concurrentExecutions?: number;
  readonly stateDrift?: boolean;
  readonly sharedExecution?: boolean;
  readonly aggregate?: boolean;
  readonly retryable?: boolean;
  readonly missingPhase?: string;
  readonly missingScript?: string;
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
  readonly preparationDurationMs?: number;
  readonly authorizationDurationMs?: number;
  readonly queueDurationMs?: number;
  readonly output: ProjectCommandInvocationOutputMetadata;
  readonly measurements?: ProjectCommandInvocationMeasurements;
  readonly producerScope?: "session" | "flow";
  readonly flowId?: string;
  readonly delegationId?: string;
  readonly role?: string;
  readonly ref?: string;
  readonly repositoryState?: ProjectCommandInvocationRepositoryStateMetadata;
  readonly verdict?: "passed" | "failed" | "incomplete";
  readonly mutating?: boolean;
  readonly publication?: ProjectCommandInvocationPublicationMetadata;
  readonly lookup?: ProjectCommandInvocationLookupMetadata;
  readonly coercions?: readonly string[];
  readonly concurrentExecutions?: number;
  readonly stateDrift?: boolean;
  readonly sharedExecution?: boolean;
  readonly aggregate?: boolean;
  readonly retryable?: boolean;
  readonly missingPhase?: string;
  readonly missingScript?: string;
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
  readonly measurements: ProjectCommandInvocationMeasurements;
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
