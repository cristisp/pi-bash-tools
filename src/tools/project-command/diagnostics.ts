import type { ProjectCommandOutput } from "./execution.ts";

export const PROJECT_COMMAND_DIAGNOSTIC_MAX_CHARS = 2_000;

const ESCAPE = 0x1b;
const BELL = 0x07;
const STRING_TERMINATOR = 0x9c;
const C1_CSI = 0x9b;
const C1_OSC = 0x9d;
const C1_CONTROL_STRING_STARTS = new Set([0x90, 0x98, 0x9e, 0x9f]);
const ESCAPE_CONTROL_STRING_STARTS = new Set([0x50, 0x58, 0x5e, 0x5f]);
const NODE_PACKAGE_SCRIPT_BANNER = /^>\s+(?:@[^/\s]+\/)?[^@\s]+@[^\s]+\s+\S+(?:\s.*)?$/u;
const NODE_PACKAGE_SCRIPT_COMMANDS = new Set([
  "node_test",
  "node_test_coverage",
  "node_e2e",
  "node_build",
  "node_lint",
  "node_lint_fix",
  "node_typecheck",
  "node_format_check",
  "node_format_write",
]);

function nextCodePointIndex(text: string, index: number): number {
  const codePoint = text.codePointAt(index);
  return index + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1);
}

function skipControlString(text: string, index: number, terminatesAtBell: boolean): number {
  let current = index;
  while (current < text.length) {
    const codePoint = text.codePointAt(current);
    if ((terminatesAtBell && codePoint === BELL) || codePoint === STRING_TERMINATOR) {
      return current + 1;
    }
    if (codePoint === ESCAPE && text.charCodeAt(current + 1) === 0x5c) {
      return current + 2;
    }
    current = nextCodePointIndex(text, current);
  }
  return text.length;
}

function skipCsi(text: string, index: number): number {
  let current = index;
  while (current < text.length) {
    const codePoint = text.charCodeAt(current);
    if (codePoint < 0x30 || codePoint > 0x3f) {
      break;
    }
    current += 1;
  }
  while (current < text.length) {
    const codePoint = text.charCodeAt(current);
    if (codePoint < 0x20 || codePoint > 0x2f) {
      break;
    }
    current += 1;
  }
  if (current < text.length) {
    const final = text.charCodeAt(current);
    if (final >= 0x40 && final <= 0x7e) {
      return current + 1;
    }
  }
  return current;
}

function removeTerminalSequences(text: string): string {
  let cleaned = "";
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index);
    if (codePoint === ESCAPE) {
      const next = text.charCodeAt(index + 1);
      if (next === 0x5d || ESCAPE_CONTROL_STRING_STARTS.has(next)) {
        index = skipControlString(text, index + 2, next === 0x5d);
      } else if (next === 0x5b) {
        index = skipCsi(text, index + 2);
      } else if (next !== undefined && next >= 0x40 && next <= 0x5f) {
        index += 2;
      } else {
        index = nextCodePointIndex(text, index);
      }
      continue;
    }
    if (codePoint === C1_OSC || C1_CONTROL_STRING_STARTS.has(codePoint ?? -1)) {
      index = skipControlString(text, nextCodePointIndex(text, index), codePoint === C1_OSC);
      continue;
    }
    if (codePoint === C1_CSI) {
      index = skipCsi(text, nextCodePointIndex(text, index));
      continue;
    }
    cleaned += text.slice(index, nextCodePointIndex(text, index));
    index = nextCodePointIndex(text, index);
  }
  return cleaned;
}

function removeNonPrintingControls(text: string): string {
  let cleaned = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x08 ||
        codePoint === 0x0b ||
        codePoint === 0x0c ||
        (codePoint >= 0x0e && codePoint <= 0x1f) ||
        (codePoint >= 0x80 && codePoint <= 0x9f) ||
        codePoint === 0x7f)
    ) {
      continue;
    }
    cleaned += character;
  }
  return cleaned;
}

export function sanitizeProjectCommandText(text: string): string {
  return removeNonPrintingControls(removeTerminalSequences(text)).replace(/\r\n?/gu, "\n");
}

function withoutCommandBanner(text: string, commandId: string): string {
  if (!NODE_PACKAGE_SCRIPT_COMMANDS.has(commandId)) {
    return text;
  }
  return text
    .split("\n")
    .filter((line) => !NODE_PACKAGE_SCRIPT_BANNER.test(line.trim()))
    .join("\n");
}

function boundSanitizedProjectCommandText(text: string): string {
  if (text.length <= PROJECT_COMMAND_DIAGNOSTIC_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, PROJECT_COMMAND_DIAGNOSTIC_MAX_CHARS - 3)}...`;
}

export function boundProjectCommandText(text: string): string {
  return boundSanitizedProjectCommandText(sanitizeProjectCommandText(text));
}

function boundedDiagnostic(text: string, commandId: string): string | undefined {
  const cleaned = withoutCommandBanner(sanitizeProjectCommandText(text), commandId).trim();
  if (cleaned.length === 0) {
    return undefined;
  }
  return boundSanitizedProjectCommandText(cleaned);
}

export function projectCommandDiagnostic(
  commandId: string,
  stderr: ProjectCommandOutput,
  stdout: ProjectCommandOutput,
): string | undefined {
  return boundedDiagnostic(stderr.text, commandId) ?? boundedDiagnostic(stdout.text, commandId);
}
