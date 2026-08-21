export const NODE_TEST_PATH_PATTERN =
  "^(?!-)(?!/)(?![A-Za-z]:[\\\\/])(?!.*[\\\\*?\\[\\]{}\\u0000-\\u001f\\u007f])(?!.*(?:^|/)\\.{1,2}(?:/|$)).+$";

export const NODE_TEST_PARAMETERS = Object.freeze([
  Object.freeze({
    name: "paths",
    kind: "workspace-paths" as const,
    required: false,
    mapping: "repeated-after-separator" as const,
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
