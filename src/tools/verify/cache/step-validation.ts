import {
  isBoundedInteger,
  isBoundedNonEmptyString,
  isBoundedString,
  isNullableBoundedInteger,
  isRecord,
} from "../../value-validation.ts";
import { type VerifyOutputChunk, type VerifyStepResult } from "../types.ts";

const VERIFY_CACHE_MAX_TEXT = 50 * 1024;
export const VERIFY_CACHE_MAX_COMMAND = 300 * 1024;
const VERIFY_CACHE_MAX_TAIL = 8 * 1024;
const ANSI_ESCAPE = String.fromCodePoint(0x1b);

function isOutputChunk(value: unknown): value is VerifyOutputChunk {
  return (
    isRecord(value) &&
    isBoundedString(value.text, VERIFY_CACHE_MAX_TEXT) &&
    typeof value.truncated === "boolean" &&
    isBoundedInteger(value.totalBytes, 0, Number.MAX_SAFE_INTEGER) &&
    isBoundedInteger(value.totalLines, 0, Number.MAX_SAFE_INTEGER)
  );
}

export function isSafeFailureTail(value: unknown, status: unknown): value is string | undefined {
  return (
    value === undefined ||
    (status === "failed" &&
      isBoundedString(value, VERIFY_CACHE_MAX_TAIL) &&
      !value.includes(ANSI_ESCAPE))
  );
}

export function isVerifyStepResult(value: unknown): value is VerifyStepResult {
  if (!isRecord(value)) return false;
  if (value.status === "passed" && value.executed === false) return false;
  return (
    (value.phase === "format" ||
      value.phase === "lint" ||
      value.phase === "typecheck" ||
      value.phase === "test") &&
    (value.status === "passed" ||
      value.status === "failed" ||
      value.status === "not-run" ||
      value.status === "omitted") &&
    value.verdict === value.status &&
    typeof value.executed === "boolean" &&
    value.executed === (value.status === "passed" || value.status === "failed") &&
    (value.command === undefined ||
      isBoundedNonEmptyString(value.command, VERIFY_CACHE_MAX_COMMAND)) &&
    (value.resolvedCommand === undefined ||
      isBoundedNonEmptyString(value.resolvedCommand, VERIFY_CACHE_MAX_COMMAND)) &&
    (value.executable === undefined || isBoundedString(value.executable, 4096)) &&
    (value.args === undefined ||
      (Array.isArray(value.args) && value.args.every((arg) => isBoundedString(arg, 4096)))) &&
    (value.script === undefined || isBoundedString(value.script, 128)) &&
    isNullableBoundedInteger(value.exitCode, -1, 255) &&
    (value.signal === null || isBoundedString(value.signal, 128)) &&
    isBoundedInteger(value.durationMs, 0, 24 * 60 * 60 * 1000) &&
    isOutputChunk(value.stdout) &&
    isOutputChunk(value.stderr) &&
    isSafeFailureTail(value.failureTail, value.status) &&
    (value.reason === undefined || isBoundedString(value.reason, 1024))
  );
}
