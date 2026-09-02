import { decodeUtf8Prefix, type Truncation } from "../../truncation.ts";
import type { GitDiffHunk, GitDiffSummaryOutput } from "./output.ts";
import type { GitStatusEntry } from "../status/output.ts";
import { MAX_RECORDS } from "../output.ts";

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r\n|\r|\n/u).length - (text.endsWith("\n") || text.endsWith("\r") ? 1 : 0);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function boundedText(text: string, maxBytes: number): string {
  return decodeUtf8Prefix(Buffer.from(text, "utf8"), maxBytes);
}

interface GitPathToken {
  readonly value: string;
  readonly end: number;
}

const C_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  e: 0x1b,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  "\\": 0x5c,
  '"': 0x22,
};

function appendUtf8(bytes: number[], value: string): void {
  bytes.push(...Buffer.from(value, "utf8"));
}

function parseQuotedGitPath(line: string, start: number): GitPathToken | undefined {
  if (line[start] !== '"') return undefined;
  const bytes: number[] = [];
  for (let index = start + 1; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      return { value: Buffer.from(bytes).toString("utf8"), end: index + 1 };
    }
    if (character !== "\\") {
      const codePoint = line.codePointAt(index);
      appendUtf8(bytes, codePoint === undefined ? "" : String.fromCodePoint(codePoint));
      if (codePoint !== undefined && codePoint > 0xffff) index += 1;
      continue;
    }

    const escaped = line[index + 1];
    if (escaped === undefined) return undefined;
    const simpleEscape = C_ESCAPES[escaped];
    if (simpleEscape !== undefined) {
      bytes.push(simpleEscape);
      index += 1;
      continue;
    }
    if (escaped < "0" || escaped > "7") return undefined;

    let byte = escaped.charCodeAt(0) - "0".charCodeAt(0);
    let consumed = 1;
    while (consumed < 3) {
      const next = line[index + 1 + consumed];
      if (next === undefined || next < "0" || next > "7") break;
      byte = byte * 8 + next.charCodeAt(0) - "0".charCodeAt(0);
      consumed += 1;
    }
    bytes.push(byte);
    index += consumed;
  }
  return undefined;
}

function parseGitPathToken(line: string, start: number, end: number): GitPathToken | undefined {
  if (line[start] === '"') {
    const token = parseQuotedGitPath(line, start);
    if (token === undefined || token.end !== end) return undefined;
    return token;
  }
  if (start >= end) return undefined;
  return { value: line.slice(start, end), end };
}

function skipSpaces(line: string, start: number): number {
  let index = start;
  while (line[index] === " ") index += 1;
  return index;
}

function parseDiffHeader(line: string): string | undefined {
  const prefix = "diff --git ";
  if (!line.startsWith(prefix)) return undefined;
  const start = prefix.length;
  if (line[start] === '"') {
    const oldToken = parseQuotedGitPath(line, start);
    if (oldToken === undefined) return undefined;
    const newStart = skipSpaces(line, oldToken.end);
    const newToken = parseGitPathToken(line, newStart, line.length);
    if (newToken === undefined || newToken.end !== line.length) return undefined;
    if (!oldToken.value.startsWith("a/") || !newToken.value.startsWith("b/")) return undefined;
    return newToken.value.slice(2);
  }

  // Unquoted Git paths may contain spaces. The separator is the last space
  // before the b/ path, matching Git's normal two-path header layout.
  for (let separator = line.length - 1; separator >= start; separator -= 1) {
    if (line[separator] !== " ") continue;
    const oldPath = line.slice(start, separator);
    if (!oldPath.startsWith("a/")) continue;
    const newStart = skipSpaces(line, separator);
    const newToken = parseGitPathToken(line, newStart, line.length);
    if (newToken === undefined || newToken.end !== line.length) continue;
    if (!newToken.value.startsWith("b/")) continue;
    return newToken.value.slice(2);
  }
  return undefined;
}

function parseNewPathHeader(line: string): string | undefined {
  const prefix = "+++ ";
  if (!line.startsWith(prefix)) return undefined;
  const start = prefix.length;
  let token: GitPathToken | undefined;
  if (line[start] === '"') {
    token = parseQuotedGitPath(line, start);
    if (token === undefined || (line[token.end] !== undefined && line[token.end] !== "\t")) {
      return undefined;
    }
  } else {
    const tab = line.indexOf("\t", start);
    const end = tab === -1 ? line.length : tab;
    token = parseGitPathToken(line, start, end);
  }
  if (token === undefined || token.value === "/dev/null" || !token.value.startsWith("b/")) {
    return undefined;
  }
  return token.value.slice(2);
}

/** Extract only Git hunk headers; no hunk body lines are retained. */
export function parseDiffHunkHeaders(text: string): GitDiffHunk[] {
  const hunks: GitDiffHunk[] = [];
  let currentPath = "(unknown)";
  for (const line of text.split(/\r\n|\r|\n/u)) {
    const fileHeader = parseDiffHeader(line);
    if (fileHeader !== undefined) {
      currentPath = fileHeader;
      continue;
    }
    const newPath = parseNewPathHeader(line);
    if (newPath !== undefined) {
      currentPath = newPath;
      continue;
    }
    if (line.startsWith("@@ ")) {
      hunks.push({ path: currentPath, header: line });
    }
  }
  return hunks;
}

function serializeParts(
  status: readonly GitStatusEntry[],
  stat: string,
  hunks: readonly GitDiffHunk[],
): string {
  return JSON.stringify({ status, stat, hunks });
}

function boundedParts(
  status: readonly GitStatusEntry[],
  stat: string,
  hunks: readonly GitDiffHunk[],
  maxBytes: number,
): {
  readonly status: readonly GitStatusEntry[];
  readonly stat: string;
  readonly hunks: readonly GitDiffHunk[];
} {
  let boundedStatus = [...status];
  let boundedStat = stat;
  let boundedHunks = [...hunks];
  while (byteLength(serializeParts(boundedStatus, boundedStat, boundedHunks)) > maxBytes) {
    if (boundedHunks.length > 0) {
      boundedHunks = boundedHunks.slice(0, Math.max(0, Math.floor(boundedHunks.length / 2)));
      continue;
    }
    if (boundedStatus.length > 0) {
      boundedStatus = boundedStatus.slice(0, Math.max(0, Math.floor(boundedStatus.length / 2)));
      continue;
    }
    const currentBytes = byteLength(boundedStat);
    if (currentBytes === 0) break;
    const nextBytes = Math.max(1, Math.floor(currentBytes / 2));
    const next = boundedText(boundedStat, nextBytes);
    if (next === boundedStat) {
      boundedStat = "";
      break;
    }
    boundedStat = next;
  }
  return { status: boundedStatus, stat: boundedStat, hunks: boundedHunks };
}

export function createGitDiffSummary(
  displayStatus: readonly GitStatusEntry[],
  stat: string,
  diffText: string,
  maxBytes: number,
  sourceTruncated = false,
  completeStatus: readonly GitStatusEntry[] = displayStatus,
): GitDiffSummaryOutput {
  const hunks = parseDiffHunkHeaders(diffText);
  const completeSummary = serializeParts(completeStatus, stat, hunks);
  const totalBytes = byteLength(completeSummary);
  const boundedDisplayStatus = displayStatus.slice(0, MAX_RECORDS);
  const bounded = boundedParts(boundedDisplayStatus, stat, hunks, maxBytes);
  const recordsTruncated = completeStatus.length > boundedDisplayStatus.length;
  const summaryTruncated = totalBytes > maxBytes;
  const truncated = sourceTruncated || recordsTruncated || summaryTruncated;
  const output: Truncation = {
    truncated,
    totalBytes,
    totalLines: countLines(completeSummary),
  };
  const message = truncated
    ? `INCOMPLETE git_diff summary: ${summaryTruncationGuidance(
        totalBytes,
        maxBytes,
        recordsTruncated,
        sourceTruncated,
      )} The status and per-file diff stat are included where possible; hunk bodies are omitted. Follow up with an explicit scoped summary request such as { mode: "summary", paths: ["file"], maxBytes: ${Math.min(maxBytes * 4, 1024 * 1024)} }.`
    : 'git_diff summary: status, per-file diff stat, and hunk headers are shown; hunk bodies are omitted. Use mode: "patch" with paths for scoped content.';
  return {
    mode: "summary",
    ...bounded,
    output,
    message,
  };
}

function summaryTruncationGuidance(
  totalBytes: number,
  maxBytes: number,
  recordsTruncated: boolean,
  sourceTruncated: boolean,
): string {
  const reasons: string[] = [];
  if (recordsTruncated) {
    reasons.push(`status records exceed the ${MAX_RECORDS}-record response bound`);
  }
  if (sourceTruncated && !recordsTruncated) {
    reasons.push("some source status data was bounded before summary creation");
  }
  if (totalBytes > maxBytes) {
    reasons.push(
      `${totalBytes} bytes of complete summary data exceed the ${maxBytes}-byte response bound`,
    );
  }
  return reasons.join("; ");
}
