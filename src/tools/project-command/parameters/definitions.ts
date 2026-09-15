const PATH_FORBIDDEN_CHARS = "\\\\*?\\[\\]{}\\u0000-\\u001f\\u007f\\u0080-\\u009f\\u2028\\u2029";

const pathSegmentRest = `[^${PATH_FORBIDDEN_CHARS}/]*`;
const pathSegmentFirst = `[^./${PATH_FORBIDDEN_CHARS}]`;
const pathDotSegment = `(?:\\.${pathSegmentFirst}${pathSegmentRest}|\\.[\\.][^./${PATH_FORBIDDEN_CHARS}]${pathSegmentRest}|\\.[\\.][\\.][^${PATH_FORBIDDEN_CHARS}/]*)`;
const pathSegment = `(?:${pathSegmentFirst}${pathSegmentRest}|${pathDotSegment})`;
const pathFirstSegment = `(?:[A-Za-z]:[^/${PATH_FORBIDDEN_CHARS}]${pathSegmentRest}|[A-Za-z][^:/${PATH_FORBIDDEN_CHARS}]${pathSegmentRest}|[A-Za-z]|[^-${PATH_FORBIDDEN_CHARS}A-Za-z./]${pathSegmentRest}|${pathDotSegment})`;

export const NODE_TEST_PATH_PATTERN = `^${pathFirstSegment}(?:/${pathSegment})*$`;

export const PROJECT_COMMAND_SCRIPT_VARIANT_PATTERN =
  "^[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)*$";
export const PROJECT_COMMAND_MAX_SCRIPT_VARIANT_LENGTH = 128;

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

export const FALLOW_REVISION_PATTERN = "^[A-Za-z0-9_./@^~{}+=,](?:-?[A-Za-z0-9_./@^~{}+=,])*-?$";

export {
  PROJECT_COMMAND_MAX_FORWARDED_ARGUMENT_BYTES,
  PROJECT_COMMAND_MAX_PARAMETER_ITEMS,
  PROJECT_COMMAND_MAX_PATH_LENGTH,
} from "./limits.ts";
