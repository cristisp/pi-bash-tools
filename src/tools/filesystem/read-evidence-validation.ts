import { createHash } from "node:crypto";

import {
  EVIDENCE_PRODUCER,
  isBoundedSharedEvidenceOutput,
  isBoundedSharedEvidenceWorkspace,
  sharedEvidenceContentHash,
} from "../../evidence/envelope.ts";
import { isRecord } from "../value-validation.ts";
import type {
  ReadEvidenceEntry,
  ReadEvidenceRange,
  ReadEvidenceRecord,
} from "./read-evidence-store.ts";

export const READ_EVIDENCE_REF_PATTERN = /^rr_[0-9a-f]{24}$/u;
export const READ_EVIDENCE_REF_PREFIX = "rr_";
export const READ_EVIDENCE_MAX_ENTRIES = 32;
export const READ_EVIDENCE_MAX_PATH_LENGTH = 4_096;
export const READ_EVIDENCE_MAX_OFFSET = 1_000_000;
export const READ_EVIDENCE_MAX_RANGE_LINES = 2_000;
export const READ_EVIDENCE_MAX_CONTENT_BYTES = 64 * 1024;
export const READ_EVIDENCE_MAX_AGGREGATE_CONTENT_BYTES = 256 * 1024;
export const READ_EVIDENCE_MAX_RECORD_BYTES = 384 * 1024;

const READ_EVIDENCE_FLOW_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export function readEvidenceRecordRef(contentHash: string): string {
  const digest = createHash("sha256")
    .update("read-evidence-v1", "utf8")
    .update("\0", "utf8")
    .update(contentHash, "utf8")
    .digest("hex");
  return `${READ_EVIDENCE_REF_PREFIX}${digest.slice(0, 24)}`;
}

function isBoundedPath(value: unknown): boolean {
  return (
    typeof value === "string" && value.length > 0 && value.length <= READ_EVIDENCE_MAX_PATH_LENGTH
  );
}

function isBoundedRange(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => key !== "offset" && key !== "limit")) return false;
  const offset = value.offset;
  const limit = value.limit;
  return (
    (offset === undefined ||
      (typeof offset === "number" &&
        Number.isInteger(offset) &&
        offset >= 1 &&
        offset <= READ_EVIDENCE_MAX_OFFSET)) &&
    (limit === undefined ||
      (typeof limit === "number" &&
        Number.isInteger(limit) &&
        limit >= 1 &&
        limit <= READ_EVIDENCE_MAX_RANGE_LINES))
  );
}

function isBoundedEntry(value: unknown): value is ReadEvidenceEntry {
  return (
    isRecord(value) &&
    isBoundedPath(value.path) &&
    isBoundedRange(value.range) &&
    typeof value.contentHash === "string" &&
    SHA256_PATTERN.test(value.contentHash) &&
    typeof value.content === "string" &&
    Buffer.byteLength(value.content, "utf8") <= READ_EVIDENCE_MAX_CONTENT_BYTES &&
    isBoundedSharedEvidenceOutput(value.output)
  );
}

export function readEvidenceRecordBytes(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return undefined;
  }
}

function isBoundedRecordBytes(value: unknown): boolean {
  const bytes = readEvidenceRecordBytes(value);
  return bytes !== undefined && bytes <= READ_EVIDENCE_MAX_RECORD_BYTES;
}

function isBoundedProvenance(
  value: unknown,
): value is { readonly scope: "flow"; readonly flowId: string } {
  return (
    isRecord(value) &&
    value.scope === "flow" &&
    typeof value.flowId === "string" &&
    READ_EVIDENCE_FLOW_ID_PATTERN.test(value.flowId)
  );
}

export function isReadEvidenceRecord(
  value: unknown,
  scopeKey?: string,
): value is ReadEvidenceRecord {
  if (!isRecord(value)) return false;
  if (value.evidenceFormatVersion !== 1) return false;
  if (typeof value.ref !== "string" || !READ_EVIDENCE_REF_PATTERN.test(value.ref)) return false;
  if (value.producer !== EVIDENCE_PRODUCER) return false;
  if (value.kind !== "read-batch") return false;
  if (value.scope !== "flow") return false;
  if (typeof value.requestHash !== "string" || !SHA256_PATTERN.test(value.requestHash))
    return false;
  if (typeof value.contentHash !== "string" || !SHA256_PATTERN.test(value.contentHash))
    return false;
  if (value.workspace !== undefined && !isBoundedSharedEvidenceWorkspace(value.workspace)) {
    return false;
  }
  if (value.output !== undefined && !isBoundedSharedEvidenceOutput(value.output)) return false;
  if (!isBoundedProvenance(value.provenance)) return false;
  if (scopeKey !== undefined && value.provenance.flowId !== scopeKey) return false;
  const entries: unknown = value.entries;
  if (
    !Array.isArray(entries) ||
    entries.length === 0 ||
    entries.length > READ_EVIDENCE_MAX_ENTRIES
  ) {
    return false;
  }
  let totalContentBytes = 0;
  const contentInputs: Array<{
    readonly path: string;
    readonly range: ReadEvidenceRange | null;
    readonly contentHash: string;
  }> = [];
  for (const entry of entries) {
    if (!isBoundedEntry(entry)) return false;
    if (!isRecord(entry) || typeof entry.content !== "string") return false;
    totalContentBytes += Buffer.byteLength(entry.content, "utf8");
    if (totalContentBytes > READ_EVIDENCE_MAX_AGGREGATE_CONTENT_BYTES) return false;
    contentInputs.push({
      path: entry.path,
      range: entry.range ?? null,
      contentHash: entry.contentHash,
    });
  }
  if (sharedEvidenceContentHash(contentInputs) !== value.contentHash) return false;
  if (readEvidenceRecordRef(value.contentHash) !== value.ref) return false;
  return isBoundedRecordBytes(value);
}
