import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

import { isRecord } from "../value-validation.ts";
import { getProjectCommandDefinitions } from "./definitions.ts";
import { ProjectCommandToolError, validateProjectCommandInput } from "./schema/validation.ts";

export type ProjectCommandErrorDetails = Readonly<Record<string, unknown>>;

export interface ProjectCommandErrorDetailsStore {
  readonly record: (toolCallId: string, details: unknown) => void;
  readonly take: (toolCallId: string) => unknown;
}

const MAX_PENDING_ERROR_DETAILS = 128;

export function createProjectCommandErrorDetailsStore(): ProjectCommandErrorDetailsStore {
  const pending = new Map<string, unknown>();

  return {
    record(toolCallId, details) {
      if (toolCallId.length === 0) return;
      if (!pending.has(toolCallId) && pending.size >= MAX_PENDING_ERROR_DETAILS) {
        const oldest = pending.keys().next().value;
        if (typeof oldest === "string") pending.delete(oldest);
      }
      pending.set(toolCallId, details);
    },
    take(toolCallId) {
      const details = pending.get(toolCallId);
      pending.delete(toolCallId);
      return details;
    },
  };
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
