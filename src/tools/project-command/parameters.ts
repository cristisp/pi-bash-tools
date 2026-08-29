import { normalizeNodeTestParametersInternal } from "./parameters/normalization.ts";
import type { NodeTestParameters } from "./parameters/types.ts";

export {
  FALLOW_AUDIT_PARAMETERS,
  FALLOW_REVISION_PATTERN,
  NODE_TEST_PARAMETERS,
  NODE_TEST_PATH_PATTERN,
  PROJECT_COMMAND_MAX_FORWARDED_ARGUMENT_BYTES,
  PROJECT_COMMAND_MAX_PARAMETER_ITEMS,
  PROJECT_COMMAND_MAX_PATH_LENGTH,
  PROJECT_COMMAND_MAX_SCRIPT_VARIANT_LENGTH,
  PROJECT_COMMAND_SCRIPT_VARIANT_PATTERN,
} from "./parameters/definitions.ts";
export {
  validateNodeTestPaths,
  validateProjectCommandRevision,
  validateWorkspacePathParameter,
} from "./parameters/validation.ts";
export type { NodeTestParameters, ProjectCommandParameterDeclaration } from "./parameters/types.ts";

export function normalizeNodeTestParameters(
  value: unknown,
  canonicalProjectPath: string,
): Promise<NodeTestParameters> {
  return normalizeNodeTestParametersInternal(value, canonicalProjectPath);
}
