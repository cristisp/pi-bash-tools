import {
  defaultConfirmationTimeoutMs,
  environmentVariableNamePattern,
} from "./format/constants.ts";
import {
  createEmptyEnvironmentPolicyInternal,
  parseEnvironmentPolicyInternal,
  serializePolicyInternal,
} from "./format/environment.ts";
import {
  assertPolicyAllowedKeysInternal,
  isPolicyRecordInternal,
  policyErrorInternal,
} from "./format/errors.ts";
import {
  createEmptyFilesystemPolicyInternal,
  parseFilesystemPolicyInternal,
} from "./format/filesystem.ts";
import {
  isEnvironmentVariableNameInternal,
  validatePolicyPathInternal,
  validateProjectPathInternal,
} from "./format/validation.ts";
import type { EnvironmentPolicyData, FilesystemPolicyData } from "./types.ts";

export const DEFAULT_CONFIRMATION_TIMEOUT_MS = defaultConfirmationTimeoutMs;
export const ENVIRONMENT_VARIABLE_NAME_PATTERN = environmentVariableNamePattern;

export function policyError(): Error {
  return policyErrorInternal();
}

export function isPolicyRecord(value: unknown): value is Record<string, unknown> {
  return isPolicyRecordInternal(value);
}

export function assertPolicyAllowedKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
): void {
  assertPolicyAllowedKeysInternal(value, allowed);
}

export function isEnvironmentVariableName(value: string): boolean {
  return isEnvironmentVariableNameInternal(value);
}

export function validateProjectPath(path: string): string {
  return validateProjectPathInternal(path);
}

export function validatePolicyPath(path: string): string {
  return validatePolicyPathInternal(path);
}

export function createEmptyEnvironmentPolicy(): EnvironmentPolicyData {
  return createEmptyEnvironmentPolicyInternal();
}

export function createEmptyFilesystemPolicy(): FilesystemPolicyData {
  return createEmptyFilesystemPolicyInternal();
}

export function parseEnvironmentPolicy(text: string): EnvironmentPolicyData {
  return parseEnvironmentPolicyInternal(text);
}

export function parseFilesystemPolicy(value: unknown): FilesystemPolicyData {
  return parseFilesystemPolicyInternal(value);
}

export function serializePolicy(policy: EnvironmentPolicyData): string {
  return serializePolicyInternal(policy);
}
