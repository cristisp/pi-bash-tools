import { createHash } from "node:crypto";

import { hashCanonicalJson } from "../observability/canonical-json.ts";
import {
  isBoundedInteger,
  isBoundedNonEmptyString,
  isBoundedString,
  isRecord,
} from "../tools/value-validation.ts";

export const EVIDENCE_ENVELOPE_FORMAT_VERSION = 1 as const;

export const EVIDENCE_PRODUCER = "bash-tools" as const;

export const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export type SharedEvidenceScope = "session" | "flow";

export type SharedEvidenceKind = "project-command" | "verify" | "read-batch";

export interface SharedEvidenceWorkspaceBlock {
  readonly repositoryId: string;
  readonly head: string | null;
  readonly dirtyDigest: string | null;
  readonly status: "readable" | "degraded";
}

export interface SharedEvidenceOutputBlock {
  readonly truncated: boolean;
  readonly totalBytes: number;
  readonly totalLines: number;
}

interface SharedEvidenceEnvelopeFields {
  readonly producer: typeof EVIDENCE_PRODUCER;
  readonly kind: SharedEvidenceKind;
  readonly scope: SharedEvidenceScope;
  readonly requestHash: string;
  readonly contentHash: string;
  readonly workspace?: SharedEvidenceWorkspaceBlock;
  readonly output?: SharedEvidenceOutputBlock;
}

export interface SharedEvidenceRecord extends SharedEvidenceEnvelopeFields {
  readonly evidenceFormatVersion: typeof EVIDENCE_ENVELOPE_FORMAT_VERSION;
  readonly ref: string;
}

export function sharedRepositoryId(repositoryIdentity: string): string {
  return createHash("sha256").update(repositoryIdentity, "utf8").digest("hex");
}

export function sharedEvidenceRequestHash(request: unknown): string {
  return hashCanonicalJson(request);
}

export function sharedEvidenceContentHash(content: unknown): string {
  return hashCanonicalJson(content);
}

export function sharedWorkspaceBlock(state: {
  readonly repositoryIdentity: string;
  readonly head: string;
  readonly dirtyFilesDigest: string;
}): SharedEvidenceWorkspaceBlock {
  return Object.freeze({
    repositoryId: sharedRepositoryId(state.repositoryIdentity),
    head: state.head,
    dirtyDigest: state.dirtyFilesDigest,
    status: "readable",
  });
}

export function aggregateSharedEvidenceOutput(
  streams: readonly SharedEvidenceOutputBlock[],
): SharedEvidenceOutputBlock {
  return Object.freeze({
    truncated: streams.some((stream) => stream.truncated),
    totalBytes: streams.reduce((total, stream) => total + stream.totalBytes, 0),
    totalLines: streams.reduce((total, stream) => total + stream.totalLines, 0),
  });
}

export function isBoundedSharedEvidenceWorkspace(
  value: unknown,
): value is SharedEvidenceWorkspaceBlock {
  if (!isRecord(value)) return false;
  return (
    typeof value.repositoryId === "string" &&
    SHA256_PATTERN.test(value.repositoryId) &&
    (value.head === null || isBoundedString(value.head, 512)) &&
    (value.dirtyDigest === null ||
      (typeof value.dirtyDigest === "string" && value.dirtyDigest.length <= 256)) &&
    (value.status === "readable" || value.status === "degraded")
  );
}

export function isBoundedSharedEvidenceOutput(value: unknown): value is SharedEvidenceOutputBlock {
  if (!isRecord(value)) return false;
  return (
    typeof value.truncated === "boolean" &&
    isBoundedInteger(value.totalBytes, 0, Number.MAX_SAFE_INTEGER) &&
    isBoundedInteger(value.totalLines, 0, Number.MAX_SAFE_INTEGER)
  );
}

export function isBoundedSharedEvidenceFields(
  value: Readonly<Record<string, unknown>>,
  kinds: readonly SharedEvidenceKind[],
): boolean {
  return (
    (value.producer === undefined ||
      (value.producer === EVIDENCE_PRODUCER && isBoundedNonEmptyString(value.producer, 128))) &&
    (value.kind === undefined || kinds.some((kind) => kind === value.kind)) &&
    (value.scope === undefined || isBoundedSharedEvidenceScope(value.scope)) &&
    (value.requestHash === undefined ||
      (typeof value.requestHash === "string" && SHA256_PATTERN.test(value.requestHash))) &&
    (value.contentHash === undefined ||
      (typeof value.contentHash === "string" && SHA256_PATTERN.test(value.contentHash))) &&
    (value.workspace === undefined || isBoundedSharedEvidenceWorkspace(value.workspace)) &&
    (value.output === undefined || isBoundedSharedEvidenceOutput(value.output))
  );
}

function isBoundedSharedEvidenceScope(value: unknown): value is SharedEvidenceScope {
  return value === "session" || value === "flow";
}

export function isBoundedSharedEvidenceRecord(
  value: unknown,
  kinds: readonly SharedEvidenceKind[],
): value is SharedEvidenceRecord {
  if (!isRecord(value)) return false;
  return (
    value.evidenceFormatVersion === EVIDENCE_ENVELOPE_FORMAT_VERSION &&
    isBoundedNonEmptyString(value.ref, 128) &&
    value.producer === EVIDENCE_PRODUCER &&
    kinds.some((kind) => kind === value.kind) &&
    isBoundedSharedEvidenceScope(value.scope) &&
    typeof value.requestHash === "string" &&
    SHA256_PATTERN.test(value.requestHash) &&
    typeof value.contentHash === "string" &&
    SHA256_PATTERN.test(value.contentHash) &&
    (value.workspace === undefined || isBoundedSharedEvidenceWorkspace(value.workspace)) &&
    (value.output === undefined || isBoundedSharedEvidenceOutput(value.output))
  );
}
