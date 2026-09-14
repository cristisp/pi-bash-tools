import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  isBoundedSharedEvidenceWorkspace,
  type SharedEvidenceWorkspaceBlock,
} from "../evidence/envelope.ts";
import { appendInvocationStreamRecord } from "./invocation-stream.ts";

const READ_BATCH_INVOCATION_FORMAT_VERSION = 1 as const;
export const READ_BATCH_INVOCATION_ENTRY_TYPE = "bash-tools.read-batch-invocation" as const;
export const READ_BATCH_INVOCATION_MAX_BYTES = 8 * 1024;
export const READ_BATCH_INVOCATION_MAX_ITEMS = 32;

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_ERROR_CODE_LENGTH = 128;
const MAX_METADATA_NUMBER = 9_999_999_999;

export type ReadBatchInvocationReason = "completed" | "cancelled" | "invalid-request" | "failed";

export type ReadBatchInvocationLookupOutcome =
  | "success"
  | "not-found"
  | "unauthorized-flow"
  | "corrupt";

export interface ReadBatchInvocationLookupMetadata {
  readonly attempted: boolean;
  readonly success: boolean;
  readonly failure?: string;
  readonly outcome?: string;
}

function isReadBatchInvocationLookupOutcome(
  value: string,
): value is ReadBatchInvocationLookupOutcome {
  switch (value) {
    case "success":
    case "not-found":
    case "unauthorized-flow":
    case "corrupt":
      return true;
    default:
      return false;
  }
}

/** Clamp an untrusted lookup outcome string to the bounded persisted enum. */
export function readBatchInvocationLookupOutcome(
  value: string | undefined,
): ReadBatchInvocationLookupOutcome | undefined {
  if (value === undefined || !isReadBatchInvocationLookupOutcome(value)) return undefined;
  return value;
}

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
  readonly ref?: string;
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

export interface ReadBatchInvocationPublicationMetadata {
  readonly scope: "root" | "flow";
  readonly flowId?: string;
  readonly published: boolean;
  readonly error?: string;
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
  readonly lookup?: ReadBatchInvocationLookupMetadata;
  readonly role?: string;
  readonly delegationId?: string;
  readonly publication?: ReadBatchInvocationPublicationMetadata;
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
  readonly lookup?: ReadBatchInvocationLookupMetadata;
  readonly role?: string;
  readonly delegationId?: string;
  readonly publication?: ReadBatchInvocationPublicationMetadata;
}

export type ReadBatchInvocationRecorder = (record: ReadBatchInvocationRecord) => void;

export type ReadBatchInvocationAPI = Pick<ExtensionAPI, "appendEntry">;

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

function validReason(value: unknown): ReadBatchInvocationReason {
  return value === "completed" || value === "cancelled" || value === "invalid-request"
    ? value
    : "failed";
}

function validScope(value: unknown): "session" | "flow" | undefined {
  return value === "session" || value === "flow" ? value : undefined;
}

function boundedOptionalIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? boundedIdentifier(value) : undefined;
}

function boundedPublication(value: unknown): ReadBatchInvocationPublicationMetadata | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as {
    readonly scope?: unknown;
    readonly flowId?: unknown;
    readonly published?: unknown;
    readonly error?: unknown;
  };
  const flowId = boundedOptionalIdentifier(candidate.flowId);
  const error = boundedOptionalIdentifier(candidate.error);
  return {
    scope: candidate.scope === "flow" ? "flow" : "root",
    published: candidate.published === true,
    ...(flowId === undefined ? {} : { flowId }),
    ...(error === undefined ? {} : { error }),
  };
}

function boundedLookup(value: unknown): ReadBatchInvocationLookupMetadata | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as {
    readonly attempted?: unknown;
    readonly success?: unknown;
    readonly failure?: unknown;
    readonly outcome?: unknown;
  };
  if (candidate.attempted !== true) return undefined;
  const outcome = readBatchInvocationLookupOutcome(
    typeof candidate.outcome === "string" ? candidate.outcome : undefined,
  );
  return {
    attempted: true,
    success: candidate.success === true,
    ...(typeof candidate.failure === "string"
      ? { failure: boundedIdentifier(candidate.failure) }
      : {}),
    ...(outcome === undefined ? {} : { outcome }),
  };
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
    readonly ref?: unknown;
    readonly errorCode?: unknown;
  };
  const pathHash = typeof candidate.pathHash === "string" ? candidate.pathHash : "";
  const errorCode = typeof candidate.errorCode === "string" ? candidate.errorCode : undefined;
  const ref = typeof candidate.ref === "string" ? candidate.ref : undefined;
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
    ...(ref === undefined ? {} : { ref: boundedIdentifier(ref) }),
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
  const lookup = boundedLookup(input.lookup);
  const role = boundedOptionalIdentifier(input.role);
  const delegationId = boundedOptionalIdentifier(input.delegationId);
  const publication = boundedPublication(input.publication);
  const build = (frozenItems: readonly ReadBatchInvocationItem[]): ReadBatchInvocationRecord =>
    Object.freeze({
      invocationFormatVersion: READ_BATCH_INVOCATION_FORMAT_VERSION,
      sessionId: boundedIdentifier(input.sessionId),
      toolCallId: boundedIdentifier(input.toolCallId),
      schemaHash: boundedIdentifier(input.schemaHash),
      requestedPaths: boundedNumber(input.requestedPaths),
      reason: validReason(input.reason),
      executed: input.executed,
      durationMs: boundedNumber(input.durationMs),
      items: frozenItems,
      aggregate: validAggregate(input.aggregate),
      ...(scope === undefined ? {} : { scope }),
      ...(flowId === undefined ? {} : { flowId: boundedIdentifier(flowId) }),
      ...(isBoundedSharedEvidenceWorkspace(input.repositoryState)
        ? { repositoryState: input.repositoryState }
        : {}),
      ...(lookup === undefined ? {} : { lookup }),
      ...(role === undefined ? {} : { role }),
      ...(delegationId === undefined ? {} : { delegationId }),
      ...(publication === undefined ? {} : { publication }),
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
