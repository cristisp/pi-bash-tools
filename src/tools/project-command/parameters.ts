import {
  normalizeNodeE2EParametersInternal,
  normalizeNodeTestParametersInternal,
} from "./parameters/normalization.ts";
import type { NodeE2EParameters, NodeTestParameters } from "./parameters/types.ts";

export {
  FALLOW_AUDIT_PARAMETERS,
  FALLOW_REVISION_PATTERN,
  NODE_E2E_PARAMETERS,
  NODE_E2E_GREP_PATTERN,
  NODE_E2E_PROJECT_PATTERN,
  NODE_TEST_PARAMETERS,
  NODE_TEST_PATH_PATTERN,
  NODE_E2E_GREP_MAX_LENGTH,
  NODE_E2E_PROJECT_MAX_LENGTH,
  PROJECT_COMMAND_MAX_FORWARDED_ARGUMENT_BYTES,
  PROJECT_COMMAND_MAX_PARAMETER_ITEMS,
  PROJECT_COMMAND_MAX_PATH_LENGTH,
} from "./parameters/definitions.ts";
export {
  validateNodeE2EParameters,
  validateNodeTestPaths,
  validateProjectCommandRevision,
  validateWorkspacePathParameter,
} from "./parameters/validation.ts";
export type {
  NodeE2EParameters,
  NodeTestParameters,
  ProjectCommandParameterDeclaration,
} from "./parameters/types.ts";

export function normalizeNodeTestParameters(
  value: unknown,
  canonicalProjectPath: string,
): Promise<NodeTestParameters> {
  return normalizeNodeTestParametersInternal(value, canonicalProjectPath);
}

export function normalizeNodeE2EParameters(
  value: unknown,
  canonicalProjectPath: string,
): Promise<NodeE2EParameters> {
  return normalizeNodeE2EParametersInternal(value, canonicalProjectPath);
}
