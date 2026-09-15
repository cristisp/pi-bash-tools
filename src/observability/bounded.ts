const OBSERVABILITY_MAX_IDENTIFIER_LENGTH = 256;
const OBSERVABILITY_MAX_ERROR_CODE_LENGTH = 128;
export const OBSERVABILITY_MAX_METADATA_NUMBER = 9_999_999_999;

export function boundedIdentifier(value: string): string {
  if (value.length <= OBSERVABILITY_MAX_IDENTIFIER_LENGTH) return value;
  return `${value.slice(0, OBSERVABILITY_MAX_IDENTIFIER_LENGTH - 1)}…`;
}

export function boundedErrorCode(value: string): string {
  if (value.length <= OBSERVABILITY_MAX_ERROR_CODE_LENGTH) return value;
  return `${value.slice(0, OBSERVABILITY_MAX_ERROR_CODE_LENGTH - 1)}…`;
}

export function boundedNumber(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value > OBSERVABILITY_MAX_METADATA_NUMBER
    ? OBSERVABILITY_MAX_METADATA_NUMBER
    : Math.floor(value);
}

export type ObservabilityCompletionReason =
  | "completed"
  | "cancelled"
  | "invalid-request"
  | "failed";

export function validCompletionReason(value: unknown): ObservabilityCompletionReason {
  return value === "completed" || value === "cancelled" || value === "invalid-request"
    ? value
    : "failed";
}

export function boundedOptionalIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? boundedIdentifier(value) : undefined;
}

export type ObservabilityLookupOutcome = "success" | "not-found" | "unauthorized-flow" | "corrupt";

export function boundedLookupOutcome(
  value: string | undefined,
): ObservabilityLookupOutcome | undefined {
  switch (value) {
    case "success":
    case "not-found":
    case "unauthorized-flow":
    case "corrupt":
      return value;
    default:
      return undefined;
  }
}
