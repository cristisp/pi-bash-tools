import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  isBoundedSharedEvidenceWorkspace,
  type SharedEvidenceWorkspaceBlock,
} from "../evidence/envelope.ts";
import {
  boundedErrorCode,
  boundedIdentifier,
  boundedNumber,
  boundedOptionalIdentifier,
  validCompletionReason,
} from "./bounded.ts";
import { appendInvocationStreamRecord } from "./invocation-stream.ts";

const READ_BATCH_INVOCATION_FORMAT_VERSION = 2 as const;
export const READ_BATCH_INVOCATION_ENTRY_TYPE = "bash-tools.read-batch-invocation" as const;
export const READ_BATCH_INVOCATION_MAX_BYTES = 8 * 1024;
export const READ_BATCH_INVOCATION_MAX_ITEMS = 32;

export type ReadBatchInvocationReason = "completed" | "cancelled" | "invalid-request" | "failed";

export interface ReadBatchInvocationRange {
  readonly offset?: number;
  readonly limit?: number;
}

export interface ReadBatchInvocationItem {
  readonly pathHash: string;
  readonly pathLength: number;
  readonly range?: ReadBatchInvocationRange;
  readonly unchanged: boolean;
  readonly truncated: boolean;
  readonly totalBytes: number;
  readonly totalLines: number;
  readonly contentBytes: number;
  readonly errorCode?: string;
}

export interface ReadBatchInvocationAggregate {
  readonly resultBytes: number;
  readonly contentBytes: number;
  readonly totalBytes: number;
  readonly totalLines: number;
  readonly unchangedCount: number;
  readonly truncatedCount: number;
  readonly errorCount: number;
}

export interface ReadBatchInvocationRecordInput {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly schemaHash: string;
  readonly requestedPaths: number;
  readonly reason: ReadBatchInvocationReason;
  readonly executed: boolean;
  readonly durationMs: number;
  readonly items?: readonly ReadBatchInvocationItem[];
  readonly aggregate?: ReadBatchInvocationAggregate;
  readonly scope?: "session" | "flow";
  readonly flowId?: string;
  readonly repositoryState?: SharedEvidenceWorkspaceBlock;
  readonly role?: string;
  readonly delegationId?: string;
}

export interface ReadBatchInvocationRecord {
  readonly invocationFormatVersion: typeof READ_BATCH_INVOCATION_FORMAT_VERSION;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly schemaHash: string;
  readonly requestedPaths: number;
  readonly reason: ReadBatchInvocationReason;
  readonly executed: boolean;
  readonly durationMs: number;
  readonly items: readonly ReadBatchInvocationItem[];
  readonly aggregate: ReadBatchInvocationAggregate;
  readonly scope?: "session" | "flow";
  readonly flowId?: string;
  readonly repositoryState?: SharedEvidenceWorkspaceBlock;
  readonly role?: string;
  readonly delegationId?: string;
}

export type ReadBatchInvocationRecorder = (record: ReadBatchInvocationRecord) => void;

export type ReadBatchInvocationAPI = Pick<ExtensionAPI, "appendEntry">;

function validScope(value: unknown): "session" | "flow" | undefined {
  return value === "session" || value === "flow" ? value : undefined;
}

function validRange(value: unknown): ReadBatchInvocationRange | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as { readonly offset?: unknown; readonly limit?: unknown };
  const offset =
    typeof candidate.offset === "number" &&
    Number.isInteger(candidate.offset) &&
    candidate.offset > 0
      ? candidate.offset
      : undefined;
  const limit =
    typeof candidate.limit === "number" && Number.isInteger(candidate.limit) && candidate.limit > 0
      ? candidate.limit
      : undefined;
  if (offset === undefined && limit === undefined) return undefined;
  return {
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function validItem(value: unknown): ReadBatchInvocationItem | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as {
    readonly pathHash?: unknown;
    readonly pathLength?: unknown;
    readonly range?: unknown;
    readonly unchanged?: unknown;
    readonly truncated?: unknown;
    readonly totalBytes?: unknown;
    readonly totalLines?: unknown;
    readonly contentBytes?: unknown;
    readonly errorCode?: unknown;
  };
  const pathHash = typeof candidate.pathHash === "string" ? candidate.pathHash : "";
  const errorCode = typeof candidate.errorCode === "string" ? candidate.errorCode : undefined;
  const range = validRange(candidate.range);
  return {
    pathHash: boundedIdentifier(pathHash),
    pathLength: boundedNumber(typeof candidate.pathLength === "number" ? candidate.pathLength : 0),
    ...(range === undefined ? {} : { range }),
    unchanged: candidate.unchanged === true,
    truncated: candidate.truncated === true,
    totalBytes: boundedNumber(typeof candidate.totalBytes === "number" ? candidate.totalBytes : 0),
    totalLines: boundedNumber(typeof candidate.totalLines === "number" ? candidate.totalLines : 0),
    contentBytes: boundedNumber(
      typeof candidate.contentBytes === "number" ? candidate.contentBytes : 0,
    ),
    ...(errorCode === undefined ? {} : { errorCode: boundedErrorCode(errorCode) }),
  };
}

function validAggregate(value: unknown): ReadBatchInvocationAggregate {
  if (typeof value !== "object" || value === null) {
    return {
      resultBytes: 0,
      contentBytes: 0,
      totalBytes: 0,
      totalLines: 0,
      unchangedCount: 0,
      truncatedCount: 0,
      errorCount: 0,
    };
  }
  const candidate = value as {
    readonly resultBytes?: unknown;
    readonly contentBytes?: unknown;
    readonly totalBytes?: unknown;
    readonly totalLines?: unknown;
    readonly unchangedCount?: unknown;
    readonly truncatedCount?: unknown;
    readonly errorCount?: unknown;
  };
  return {
    resultBytes: boundedNumber(
      typeof candidate.resultBytes === "number" ? candidate.resultBytes : 0,
    ),
    contentBytes: boundedNumber(
      typeof candidate.contentBytes === "number" ? candidate.contentBytes : 0,
    ),
    totalBytes: boundedNumber(typeof candidate.totalBytes === "number" ? candidate.totalBytes : 0),
    totalLines: boundedNumber(typeof candidate.totalLines === "number" ? candidate.totalLines : 0),
    unchangedCount: boundedNumber(
      typeof candidate.unchangedCount === "number" ? candidate.unchangedCount : 0,
    ),
    truncatedCount: boundedNumber(
      typeof candidate.truncatedCount === "number" ? candidate.truncatedCount : 0,
    ),
    errorCount: boundedNumber(typeof candidate.errorCount === "number" ? candidate.errorCount : 0),
  };
}

/** Build a compact, persistence-safe invocation record without paths or file content. */
export function buildReadBatchInvocationRecord(
  input: ReadBatchInvocationRecordInput,
): ReadBatchInvocationRecord {
  const sourceItems = Array.isArray(input.items) ? input.items : [];
  const cappedItems = sourceItems.slice(0, READ_BATCH_INVOCATION_MAX_ITEMS);
  let items = cappedItems
    .map(validItem)
    .filter((item): item is ReadBatchInvocationItem => item !== undefined);
  const scope = validScope(input.scope);
  const flowId =
    typeof input.flowId === "string" && input.flowId.length > 0 ? input.flowId : undefined;
  const role = boundedOptionalIdentifier(input.role);
  const delegationId = boundedOptionalIdentifier(input.delegationId);
  const build = (frozenItems: readonly ReadBatchInvocationItem[]): ReadBatchInvocationRecord =>
    Object.freeze({
      invocationFormatVersion: READ_BATCH_INVOCATION_FORMAT_VERSION,
      sessionId: boundedIdentifier(input.sessionId),
      toolCallId: boundedIdentifier(input.toolCallId),
      schemaHash: boundedIdentifier(input.schemaHash),
      requestedPaths: boundedNumber(input.requestedPaths),
      reason: validCompletionReason(input.reason),
      executed: input.executed,
      durationMs: boundedNumber(input.durationMs),
      items: frozenItems,
      aggregate: validAggregate(input.aggregate),
      ...(scope === undefined ? {} : { scope }),
      ...(flowId === undefined ? {} : { flowId: boundedIdentifier(flowId) }),
      ...(isBoundedSharedEvidenceWorkspace(input.repositoryState)
        ? { repositoryState: input.repositoryState }
        : {}),
      ...(role === undefined ? {} : { role }),
      ...(delegationId === undefined ? {} : { delegationId }),
    });
  let record = build(Object.freeze(items));
  while (items.length > 0) {
    try {
      if (Buffer.byteLength(JSON.stringify(record), "utf8") <= READ_BATCH_INVOCATION_MAX_BYTES) {
        return record;
      }
    } catch {
      break;
    }
    items = items.slice(0, Math.floor(items.length / 2));
    record = build(Object.freeze(items));
  }
  return record;
}

/** Invoke an injected recorder without allowing observability failures to escape. */
export function recordReadBatchInvocation(
  recorder: ReadBatchInvocationRecorder | undefined,
  input: ReadBatchInvocationRecordInput,
): void {
  if (recorder === undefined) return;
  try {
    recorder(buildReadBatchInvocationRecord(input));
  } catch {
    // A test or alternate recorder is also best effort by contract.
  }
}

/** Create a best-effort recorder backed by Pi's session custom-entry API and JSONL stream. */
export function createReadBatchInvocationRecorder(
  api: ReadBatchInvocationAPI,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ReadBatchInvocationRecorder {
  return (record) => {
    try {
      api.appendEntry(READ_BATCH_INVOCATION_ENTRY_TYPE, record);
    } catch {
      // Observability must never change a read result or error.
    }
    appendInvocationStreamRecord(record, environment);
  };
}
