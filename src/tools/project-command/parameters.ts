import { normalizeNodeTestParametersInternal } from "./parameters/normalization.ts";
import type { NodeTestParameters } from "./parameters/types.ts";

export {
  FALLOW_AUDIT_PARAMETERS,
  FALLOW_REVISION_PATTERN,
  NODE_TEST_PARAMETERS,
  NODE_TEST_PATH_PATTERN,
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
