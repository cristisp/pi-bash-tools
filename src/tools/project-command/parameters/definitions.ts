export const NODE_TEST_PATH_PATTERN =
  "^(?!-)(?!/)(?![A-Za-z]:[\\\\/])(?!.*[\\\\*?\\[\\]{}\\u0000-\\u001f\\u007f\\u0080-\\u009f\\u2028\\u2029])(?!.*(?:^|/)\\.{1,2}(?:/|$)).+$";

export const NODE_TEST_PARAMETERS = Object.freeze([
  Object.freeze({
    name: "paths",
    kind: "workspace-paths" as const,
    required: false,
    mapping: "repeated-after-separator" as const,
  }),
]);

export const NODE_E2E_PARAMETERS = Object.freeze([
  Object.freeze({
    name: "paths",
    kind: "workspace-paths" as const,
    required: false,
    mapping: "repeated-after-separator" as const,
  }),
  Object.freeze({
    name: "grep",
    kind: "text" as const,
    required: false,
    mapping: "flag-value" as const,
  }),
  Object.freeze({
    name: "projects",
    kind: "text-list" as const,
    required: false,
    mapping: "repeated-flag-value" as const,
  }),
  Object.freeze({
    name: "workers",
    kind: "positive-integer" as const,
    required: false,
    mapping: "flag-value" as const,
  }),
  Object.freeze({
    name: "retries",
    kind: "non-negative-integer" as const,
    required: false,
    mapping: "flag-value" as const,
  }),
  Object.freeze({
    name: "headed",
    kind: "boolean" as const,
    required: false,
    mapping: "flag" as const,
  }),
  Object.freeze({
    name: "list",
    kind: "boolean" as const,
    required: false,
    mapping: "flag" as const,
  }),
]);

export const FALLOW_AUDIT_PARAMETERS = Object.freeze([
  Object.freeze({
    name: "base",
    kind: "revision" as const,
    required: true,
    mapping: "flag-value" as const,
  }),
]);

export const FALLOW_REVISION_PATTERN =
  "^(?!-)(?!.*--)(?!.*:)(?!.*\\s)(?!.*[\\\\*?\\[\\]])[A-Za-z0-9_./@^~{}+=,-]+$";

export const NODE_E2E_GREP_PATTERN =
  "^(?!-)(?!.*[\\u0000-\\u001f\\u007f\\u0080-\\u009f\\u2028\\u2029]).{1,500}$";
export const NODE_E2E_PROJECT_PATTERN =
  "^(?!-)(?!.*[\\u0000-\\u001f\\u007f\\u0080-\\u009f\\u2028\\u2029]).{1,200}$";

export {
  NODE_E2E_GREP_MAX_LENGTH,
  NODE_E2E_PROJECT_MAX_LENGTH,
  PROJECT_COMMAND_MAX_FORWARDED_ARGUMENT_BYTES,
  PROJECT_COMMAND_MAX_PARAMETER_ITEMS,
  PROJECT_COMMAND_MAX_PATH_LENGTH,
} from "./limits.ts";
