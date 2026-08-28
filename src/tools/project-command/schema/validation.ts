import {
  createToolErrorContract,
  suggestedActionForCategory,
  withToolErrorContract,
  type ToolErrorContract,
} from "../../errors.ts";
import { getProjectCommandDefinitions, type ProjectCommandDefinition } from "../definitions.ts";
import { effectiveNodeE2EParameters } from "../parameters/e2e.ts";
import {
  validateNodeE2EParameters,
  validateNodeTestPaths,
  validateProjectCommandRevision,
} from "../parameters.ts";
import { isProjectCommandResolutionError } from "../errors.ts";
import type { ProjectCommandInput, ProjectCommandInputFor } from "../schema.ts";

function defaultErrorContract(message: string): ToolErrorContract {
  return createToolErrorContract({
    code: "project-command-error",
    category: "IMPLEMENTATION_FAILURE",
    explanation: message,
    suggestedAction: suggestedActionForCategory("IMPLEMENTATION_FAILURE"),
    retryable: false,
    executed: false,
  });
}

export class ProjectCommandToolError extends Error {
  readonly details: unknown;
  readonly contract: ToolErrorContract;

  constructor(message: string, details?: unknown, contract?: ToolErrorContract) {
    super(message);
    this.name = "ProjectCommandToolError";
    this.contract = contract ?? defaultErrorContract(message);
    this.details =
      details === undefined
        ? withToolErrorContract({}, this.contract)
        : isRecord(details)
          ? withToolErrorContract(details, this.contract)
          : details;
  }
}

export function invalidRequest(invalidField?: string): ProjectCommandToolError {
  const contract = createToolErrorContract({
    code: "invalid-request",
    category: "INVALID_REQUEST",
    explanation: "The project command request does not match the supported command schema.",
    ...(invalidField === undefined ? {} : { invalidField }),
    suggestedAction: suggestedActionForCategory("INVALID_REQUEST"),
    retryable: false,
    executed: false,
  });
  return new ProjectCommandToolError(
    "Project command request is invalid",
    withToolErrorContract({}, contract),
    contract,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findDefinition(
  commandId: string,
  definitions: readonly ProjectCommandDefinition[],
): ProjectCommandDefinition {
  const matches = definitions.filter((definition) => definition.commandId === commandId);
  if (matches.length !== 1) {
    throw invalidRequest("commandId");
  }
  const definition = matches[0];
  if (definition === undefined) {
    throw invalidRequest("commandId");
  }
  return definition;
}

function validateRequestKeys(keys: readonly string[], commandId: string): void {
  const expectedKeys =
    commandId === "node_test"
      ? ["commandId", "force", "paths"]
      : commandId === "node_e2e"
        ? [
            "commandId",
            "force",
            "paths",
            "grep",
            "projects",
            "workers",
            "retries",
            "headed",
            "list",
          ]
        : commandId === "fallow_audit"
          ? ["commandId", "force", "base"]
          : ["commandId", "force"];
  const invalidKey = keys.find((key) => !expectedKeys.includes(key));
  if (!keys.includes("commandId") || invalidKey !== undefined) {
    throw invalidRequest(invalidKey ?? "commandId");
  }
}

type NormalizedProjectCommandInput = {
  readonly commandId: string;
  readonly force?: boolean;
  readonly paths?: readonly string[];
  readonly base?: string;
  readonly grep?: string;
  readonly projects?: readonly string[];
  readonly workers?: number;
  readonly retries?: number;
  readonly headed?: boolean;
  readonly list?: boolean;
};

function normalizedRequest(
  params: Record<string, unknown>,
  commandId: string,
): NormalizedProjectCommandInput {
  if (commandId === "fallow_audit") {
    try {
      return { commandId, base: validateProjectCommandRevision(params.base) };
    } catch {
      throw invalidRequest("base");
    }
  }
  if (commandId === "node_test") {
    try {
      const paths = validateNodeTestPaths(params.paths);
      return paths.length === 0 ? { commandId } : { commandId, paths };
    } catch {
      throw invalidRequest("paths");
    }
  }
  if (commandId === "node_e2e") {
    try {
      return {
        commandId,
        ...effectiveNodeE2EParameters(validateNodeE2EParameters(params)),
      };
    } catch (error) {
      if (isProjectCommandResolutionError(error)) {
        const field =
          error.code.includes("path") || error.code.includes("arguments")
            ? "paths"
            : error.code.includes("grep")
              ? "grep"
              : error.code.includes("project")
                ? "projects"
                : error.code.includes("worker")
                  ? "workers"
                  : error.code.includes("retr")
                    ? "retries"
                    : error.code.includes("headed")
                      ? "headed"
                      : error.code.includes("list")
                        ? "list"
                        : undefined;
        throw invalidRequest(field);
      }
      throw invalidRequest();
    }
  }
  return { commandId };
}

export function validateProjectCommandInput(params: unknown): ProjectCommandInput;
export function validateProjectCommandInput<
  const Definitions extends readonly ProjectCommandDefinition[],
>(params: unknown, definitions: Definitions): ProjectCommandInputFor<Definitions>;
export function validateProjectCommandInput(
  params: unknown,
  definitions: readonly ProjectCommandDefinition[] = getProjectCommandDefinitions(),
): NormalizedProjectCommandInput {
  try {
    if (!isRecord(params)) {
      throw invalidRequest();
    }
    const request = params;
    const commandId = request.commandId;
    if (typeof commandId !== "string") {
      throw invalidRequest("commandId");
    }
    findDefinition(commandId, definitions);
    validateRequestKeys(Object.keys(request), commandId);
    if (request.force !== undefined && typeof request.force !== "boolean") {
      throw invalidRequest("force");
    }
    const normalized = normalizedRequest(request, commandId);
    return request.force === true ? { ...normalized, force: true } : normalized;
  } catch (error) {
    if (error instanceof ProjectCommandToolError) {
      throw error;
    }
    throw invalidRequest();
  }
}

export function cancellationError(details?: unknown): ProjectCommandToolError {
  const executed =
    typeof details === "object" && details !== null && "executed" in details
      ? details.executed === true
      : false;
  const contract = createToolErrorContract({
    code: "cancelled",
    category: "CANCELLED",
    explanation: "The project command request was cancelled.",
    suggestedAction: suggestedActionForCategory("CANCELLED"),
    retryable: true,
    executed,
  });
  const error = new ProjectCommandToolError(
    "Project command request cancelled",
    isRecord(details)
      ? withToolErrorContract(details, contract)
      : withToolErrorContract({}, contract),
    contract,
  );
  error.name = "AbortError";
  return error;
}
