import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  isBoundedSharedEvidenceWorkspace,
  type SharedEvidenceWorkspaceBlock,
} from "../evidence/envelope.ts";
import { appendInvocationStreamRecord } from "./invocation-stream.ts";

const GIT_INVOCATION_FORMAT_VERSION = 1 as const;
export const GIT_INVOCATION_ENTRY_TYPE = "bash-tools.git-invocation" as const;
export const GIT_INVOCATION_MAX_BYTES = 8 * 1024;

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_ERROR_CODE_LENGTH = 128;
const MAX_METADATA_NUMBER = 9_999_999_999;

export type GitInvocationToolName = "git_status" | "git_diff" | "git_log" | "git_show";

export type GitInvocationReason = "completed" | "cancelled" | "invalid-request" | "failed";

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
  readonly repositoryState?: SharedEvidenceWorkspaceBlock;
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
  readonly repositoryState?: SharedEvidenceWorkspaceBlock;
}

export type GitInvocationRecorder = (record: GitInvocationRecord) => void;

export type GitInvocationAPI = Pick<ExtensionAPI, "appendEntry">;

function boundedIdentifier(value: string): string {
  if (value.length <= MAX_IDENTIFIER_LENGTH) return value;
  return `${value.slice(0, MAX_IDENTIFIER_LENGTH - 1)}…`;
}

function boundedErrorCode(value: string): string {
  if (value.length <= MAX_ERROR_CODE_LENGTH) return value;
  return `${value.slice(0, MAX_ERROR_CODE_LENGTH - 1)}…`;
}

function boundedNumber(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value > MAX_METADATA_NUMBER ? MAX_METADATA_NUMBER : Math.floor(value);
}

function validTool(value: unknown): GitInvocationToolName {
  return value === "git_status" ||
    value === "git_diff" ||
    value === "git_log" ||
    value === "git_show"
    ? value
    : "git_status";
}

function validReason(value: unknown): GitInvocationReason {
  return value === "completed" || value === "cancelled" || value === "invalid-request"
    ? value
    : "failed";
}

/** Build a compact, persistence-safe invocation record without revisions, paths, or output text. */
export function buildGitInvocationRecord(input: GitInvocationRecordInput): GitInvocationRecord {
  const errorCode = typeof input.errorCode === "string" ? input.errorCode : undefined;
  return Object.freeze({
    invocationFormatVersion: GIT_INVOCATION_FORMAT_VERSION,
    tool: validTool(input.tool),
    sessionId: boundedIdentifier(input.sessionId),
    toolCallId: boundedIdentifier(input.toolCallId),
    schemaHash: boundedIdentifier(input.schemaHash),
    requestedPaths: boundedNumber(input.requestedPaths),
    reason: validReason(input.reason),
    durationMs: boundedNumber(input.durationMs),
    unchanged: input.unchanged,
    aggregate: Object.freeze({
      resultBytes: boundedNumber(input.resultBytes),
    }),
    ...(errorCode === undefined || errorCode.length === 0
      ? {}
      : { errorCode: boundedErrorCode(errorCode) }),
    ...(isBoundedSharedEvidenceWorkspace(input.repositoryState)
      ? { repositoryState: input.repositoryState }
      : {}),
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
