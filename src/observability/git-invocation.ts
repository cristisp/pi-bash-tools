import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  isBoundedSharedEvidenceWorkspace,
  type SharedEvidenceWorkspaceBlock,
} from "../evidence/envelope.ts";
import {
  boundedErrorCode,
  boundedIdentifier,
  boundedNumber,
  validCompletionReason,
} from "./bounded.ts";
import { appendInvocationStreamRecord } from "./invocation-stream.ts";

const GIT_INVOCATION_FORMAT_VERSION = 1 as const;
export const GIT_INVOCATION_ENTRY_TYPE = "bash-tools.git-invocation" as const;
export const GIT_INVOCATION_MAX_BYTES = 8 * 1024;

const MAX_COERCION_NAME_LENGTH = 64;
const MAX_COERCIONS = 4;

export type GitInvocationToolName = "git_status" | "git_diff" | "git_log" | "git_show";

export type GitInvocationReason = "completed" | "cancelled" | "invalid-request" | "failed";

export type GitInvocationRetryInvalidation = "invalid-request-repeat";

export interface GitInvocationAggregate {
  readonly resultBytes: number;
}

export interface GitInvocationRecordInput {
  readonly tool: GitInvocationToolName;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly schemaHash: string;
  readonly requestedPaths: number;
  readonly reason: GitInvocationReason;
  readonly durationMs: number;
  readonly unchanged: boolean;
  readonly resultBytes: number;
  readonly errorCode?: string;
  readonly coercions?: readonly string[];
  readonly retryInvalidation?: GitInvocationRetryInvalidation;
  readonly repositoryState?: SharedEvidenceWorkspaceBlock;
  readonly mode?: "summary" | "patch";
  readonly maxBytes?: number;
  readonly truncated?: boolean;
}

export interface GitInvocationRecord {
  readonly invocationFormatVersion: typeof GIT_INVOCATION_FORMAT_VERSION;
  readonly tool: GitInvocationToolName;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly schemaHash: string;
  readonly requestedPaths: number;
  readonly reason: GitInvocationReason;
  readonly durationMs: number;
  readonly unchanged: boolean;
  readonly aggregate: GitInvocationAggregate;
  readonly errorCode?: string;
  readonly coercions?: readonly string[];
  readonly retryInvalidation?: GitInvocationRetryInvalidation;
  readonly repositoryState?: SharedEvidenceWorkspaceBlock;
  readonly mode?: "summary" | "patch";
  readonly maxBytes?: number;
  readonly truncated?: boolean;
}

export type GitInvocationRecorder = (record: GitInvocationRecord) => void;

export type GitInvocationAPI = Pick<ExtensionAPI, "appendEntry">;

function validTool(value: unknown): GitInvocationToolName {
  return value === "git_status" ||
    value === "git_diff" ||
    value === "git_log" ||
    value === "git_show"
    ? value
    : "git_status";
}

function boundedCoercions(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) continue;
    names.push(
      entry.length <= MAX_COERCION_NAME_LENGTH
        ? entry
        : `${entry.slice(0, MAX_COERCION_NAME_LENGTH - 1)}…`,
    );
    if (names.length >= MAX_COERCIONS) break;
  }
  return names.length === 0 ? undefined : Object.freeze(names);
}

function validRetryInvalidation(value: unknown): GitInvocationRetryInvalidation | undefined {
  return value === "invalid-request-repeat" ? value : undefined;
}

function validMode(value: unknown): "summary" | "patch" | undefined {
  return value === "summary" || value === "patch" ? value : undefined;
}

function validMaxBytes(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? boundedNumber(value)
    : undefined;
}

function validTruncated(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Build a compact, persistence-safe invocation record without revisions, paths, or output text. */
export function buildGitInvocationRecord(input: GitInvocationRecordInput): GitInvocationRecord {
  const errorCode = typeof input.errorCode === "string" ? input.errorCode : undefined;
  const coercions = boundedCoercions(input.coercions);
  const retryInvalidation = validRetryInvalidation(input.retryInvalidation);
  const mode = validMode(input.mode);
  const maxBytes = validMaxBytes(input.maxBytes);
  const truncated = validTruncated(input.truncated);
  return Object.freeze({
    invocationFormatVersion: GIT_INVOCATION_FORMAT_VERSION,
    tool: validTool(input.tool),
    sessionId: boundedIdentifier(input.sessionId),
    toolCallId: boundedIdentifier(input.toolCallId),
    schemaHash: boundedIdentifier(input.schemaHash),
    requestedPaths: boundedNumber(input.requestedPaths),
    reason: validCompletionReason(input.reason),
    durationMs: boundedNumber(input.durationMs),
    unchanged: input.unchanged,
    aggregate: Object.freeze({
      resultBytes: boundedNumber(input.resultBytes),
    }),
    ...(errorCode === undefined || errorCode.length === 0
      ? {}
      : { errorCode: boundedErrorCode(errorCode) }),
    ...(coercions === undefined ? {} : { coercions }),
    ...(retryInvalidation === undefined ? {} : { retryInvalidation }),
    ...(isBoundedSharedEvidenceWorkspace(input.repositoryState)
      ? { repositoryState: input.repositoryState }
      : {}),
    ...(mode === undefined ? {} : { mode }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(truncated === undefined ? {} : { truncated }),
  });
}

/** Invoke an injected recorder without allowing observability failures to escape. */
export function recordGitInvocation(
  recorder: GitInvocationRecorder | undefined,
  input: GitInvocationRecordInput,
): void {
  if (recorder === undefined) return;
  try {
    recorder(buildGitInvocationRecord(input));
  } catch {
    // A test or alternate recorder is also best effort by contract.
  }
}

/** Create a best-effort recorder backed by Pi's session custom-entry API and JSONL stream. */
export function createGitInvocationRecorder(
  api: GitInvocationAPI,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): GitInvocationRecorder {
  return (record) => {
    try {
      api.appendEntry(GIT_INVOCATION_ENTRY_TYPE, record);
    } catch {
      // Observability must never change a read result or error.
    }
    appendInvocationStreamRecord(record, environment);
  };
}
