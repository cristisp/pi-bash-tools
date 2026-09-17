import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

import { createToolErrorDetailsStore, type ToolErrorDetailsStore } from "../error-details-store.ts";
import { isRecord } from "../value-validation.ts";
import { getProjectCommandDefinitions } from "./definitions.ts";
import { ProjectCommandToolError, validateProjectCommandInput } from "./schema/validation.ts";

export type ProjectCommandErrorDetails = Readonly<Record<string, unknown>>;

export type ProjectCommandErrorDetailsStore = ToolErrorDetailsStore;

export function createProjectCommandErrorDetailsStore(): ProjectCommandErrorDetailsStore {
  return createToolErrorDetailsStore();
}

function detailsFromProjectCommandError(
  error: ProjectCommandToolError,
): ProjectCommandErrorDetails {
  const details = isRecord(error.details) ? error.details : {};
  return Object.freeze({
    ...details,
    resultCategory: error.contract.category,
    executed: error.contract.executed,
    retryable: error.contract.retryable,
    diagnostic:
      typeof details.diagnostic === "string" ? details.diagnostic : error.contract.explanation,
  });
}

export function projectCommandSchemaRejectionDetails(
  input: unknown,
): ProjectCommandErrorDetails | undefined {
  const definitions = getProjectCommandDefinitions();
  try {
    validateProjectCommandInput(input, definitions);
    return undefined;
  } catch (error) {
    return error instanceof ProjectCommandToolError
      ? detailsFromProjectCommandError(error)
      : undefined;
  }
}

export interface ProjectCommandToolResultHandlerResult {
  readonly details?: unknown;
}

export function createProjectCommandToolResultHandler(
  errorDetails: ProjectCommandErrorDetailsStore,
): (event: ToolResultEvent) => ProjectCommandToolResultHandlerResult | undefined {
  return (event) => {
    if (event.toolName !== "project_command") return undefined;
    const recorded = errorDetails.take(event.toolCallId);
    if (recorded !== undefined) return { details: recorded };
    if (!event.isError) return undefined;
    const rejected = projectCommandSchemaRejectionDetails(event.input);
    return rejected === undefined ? undefined : { details: rejected };
  };
}
