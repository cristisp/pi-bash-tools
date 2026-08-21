export function policyErrorInternal(): Error {
  return new Error("Environment policy is invalid or unreadable");
}

export function isPolicyRecordInternal(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertPolicyAllowedKeysInternal(
  value: Record<string, unknown>,
  allowed: Set<string>,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw policyErrorInternal();
    }
  }
}
