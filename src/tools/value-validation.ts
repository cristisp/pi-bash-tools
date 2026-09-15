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
