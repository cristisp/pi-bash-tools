import { decodeUtf8Prefix, type Truncation } from "../truncation.ts";
import { toJsonValue, type ToolStructuredContent } from "../value-validation.ts";
import { invalidGitRequest } from "./execution.ts";

export const STRUCTURED_OUTPUT_LIMIT = 50 * 1024;
export const MAX_RECORDS = 2000;
export const MAX_CONTENT_BYTES = 1024 * 1024;

export function validateIntegerLimit(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalidGitRequest(
      `${label} must be an integer from ${minimum} through ${maximum}`,
      label,
    );
  }
}

function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return text.split(/\r\n|\r|\n/u).length - (text.endsWith("\n") || text.endsWith("\r") ? 1 : 0);
}

export function truncateUtf8(
  text: string,
  maxBytes: number,
  totalLines = countLines(text),
): {
  readonly text: string;
  readonly output: Truncation;
} {
  const bytes = Buffer.from(text, "utf8");
  const truncated = bytes.byteLength > maxBytes;
  return {
    text: decodeUtf8Prefix(bytes, maxBytes),
    output: { truncated, totalBytes: bytes.byteLength, totalLines },
  };
}

/**
 * Build a result whose `structuredContent` mirrors the model-facing JSON text.
 * The host does not validate `structuredContent` against the tool's
 * `outputSchema`; package tests enforce conformance for every result mode.
 */
export function makeStructuredToolResult<T>(details: T): {
  readonly content: { type: "text"; text: string }[];
  readonly details: T;
  readonly structuredContent: ToolStructuredContent;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
    structuredContent: toJsonValue(details),
  };
}

export function countStatusRecords(text: string): number {
  const parts = text.split("\0");
  let count = 0;
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (parts[index] && parts[index].length >= 3) {
      count += 1;
      if (
        (parts[index][0] === "R" ||
          parts[index][0] === "C" ||
          parts[index][1] === "R" ||
          parts[index][1] === "C") &&
        index + 1 < parts.length - 1
      ) {
        index += 1;
      }
    }
  }
  return count;
}

export function parseStatus(text: string): Array<{
  readonly path: string;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
  readonly renamedFrom?: string;
}> {
  const parts = text.split("\0");
  const entries: Array<{
    readonly path: string;
    readonly indexStatus: string;
    readonly worktreeStatus: string;
    readonly renamedFrom?: string;
  }> = [];
  for (let index = 0; index < parts.length - 1; index += 1) {
    const record = parts[index];
    if (!record || record.length < 3) {
      continue;
    }
    const entry = {
      path: record.slice(3),
      indexStatus: record[0] ?? " ",
      worktreeStatus: record[1] ?? " ",
    };
    const isRename =
      entry.indexStatus === "R" ||
      entry.indexStatus === "C" ||
      entry.worktreeStatus === "R" ||
      entry.worktreeStatus === "C";
    if (isRename) {
      if (index + 1 >= parts.length - 1) {
        continue;
      }
      entries.push({ ...entry, renamedFrom: parts[index + 1] });
      index += 1;
    } else {
      entries.push(entry);
    }
  }
  return entries;
}

export function parseLog(
  text: string,
): Array<{ id: string; author: string; date: string; subject: string }> {
  const fields = text.split("\0");
  const entries: Array<{ id: string; author: string; date: string; subject: string }> = [];
  for (let index = 0; index + 3 < fields.length; index += 4) {
    // A bare --format= value is an implicit tformat and prefixes every
    // record after the first with Git's newline terminator.
    const id = fields[index]?.replace(/^\n/u, "");
    const author = fields[index + 1];
    const date = fields[index + 2];
    const subject = fields[index + 3];
    if (id && author !== undefined && date !== undefined && subject !== undefined) {
      entries.push({ id, author, date, subject });
    }
  }
  return entries;
}
