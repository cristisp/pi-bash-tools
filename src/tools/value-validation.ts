import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

/** JSON value the SDK accepts as tool `structuredContent` in an {@link AgentToolResult}. */
export type ToolStructuredContent = Exclude<AgentToolResult["structuredContent"], undefined>;

/**
 * Convert a JSON-serializable value into a typed `structuredContent` JSON value.
 * Mirrors JSON.stringify semantics: undefined object properties are dropped and
 * undefined array elements become null. Throws a TypeError on values JSON cannot
 * represent, so a non-conforming result fails closed instead of reaching scripts.
 */
export function toJsonValue(value: unknown): ToolStructuredContent {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("structuredContent does not support non-finite numbers");
      }
      return value;
    case "object":
      break;
    default:
      throw new TypeError("structuredContent does not support this value type");
  }
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : toJsonValue(item)));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("structuredContent does not support this value type");
  }
  const result: { [key: string]: ToolStructuredContent } = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      result[key] = toJsonValue(item);
    }
  }
  return result;
}

export const FLOW_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

export function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

export function isBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}

export function isNullableBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number | null {
  return value === null || isBoundedInteger(value, minimum, maximum);
}

export function isBoundedOutputStream(
  value: unknown,
  maximumText: number,
  maximumBytes: number,
  maximumLines: number,
): boolean {
  return (
    isRecord(value) &&
    isBoundedString(value.text, maximumText) &&
    isBoundedOutputMetadata(value, maximumBytes, maximumLines)
  );
}

export function isBoundedOutputMetadata(
  value: unknown,
  maximumBytes: number,
  maximumLines: number,
): boolean {
  return (
    isRecord(value) &&
    typeof value.truncated === "boolean" &&
    isBoundedInteger(value.totalBytes, 0, maximumBytes) &&
    isBoundedInteger(value.totalLines, 0, maximumLines)
  );
}

export function isValidPublishValue(value: unknown): value is { readonly flowId: string } {
  return (
    isRecord(value) &&
    typeof value.flowId === "string" &&
    FLOW_ID_PATTERN.test(value.flowId) &&
    Object.keys(value).every((key) => key === "flowId")
  );
}
