import type { ResultCategory } from "../errors.ts";
import type { ProjectCommandDefinition } from "./definitions.ts";
import type { ProjectCommandExecutionOutcome } from "./execution.ts";

function isAcceptedExitCode(
  definition: ProjectCommandDefinition,
  outcome: ProjectCommandExecutionOutcome,
): boolean {
  return (
    outcome.status === "nonzero" &&
    outcome.exit.code !== null &&
    (definition.acceptedExitCodes?.includes(outcome.exit.code) ?? false)
  );
}

function nonzeroCategory(definition: ProjectCommandDefinition): ResultCategory {
  switch (definition.fixedScriptKey ?? definition.commandId) {
    case "test":
    case "test:coverage":
    case "test:e2e":
    case "node_test":
    case "node_test_coverage":
    case "node_e2e":
      return "TEST_FAILURE";
    case "format:check":
    case "format":
    case "node_format_check":
    case "node_format_write":
      return "FORMAT_FAILURE";
    case "lint":
    case "lint:fix":
    case "node_lint":
    case "node_lint_fix":
      return "LINT_FAILURE";
    case "typecheck":
    case "node_typecheck":
      return "TYPE_CHECK_FAILURE";
    default:
      return "IMPLEMENTATION_FAILURE";
  }
}

/** Derive a high-level category from the known command definition and status. */
export function projectCommandResultCategory(
  definition: ProjectCommandDefinition,
  outcome: ProjectCommandExecutionOutcome,
): ResultCategory {
  if (outcome.status === "success" || isAcceptedExitCode(definition, outcome)) {
    return "PASS";
  }
  switch (outcome.status) {
    case "nonzero":
      return nonzeroCategory(definition);
    case "timeout":
      return "TIMEOUT";
    case "spawn-failure":
      return "SPAWN_FAILURE";
    case "cancelled":
      return "CANCELLED";
  }
  return "IMPLEMENTATION_FAILURE";
}

export const resultCategoryForProjectCommand = projectCommandResultCategory;
