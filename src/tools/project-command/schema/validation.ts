import { getProjectCommandDefinitions, type ProjectCommandDefinition } from "../definitions.ts";
import { validateNodeTestPaths, validateProjectCommandRevision } from "../parameters.ts";
import type { ProjectCommandInput, ProjectCommandInputFor } from "../schema.ts";

export class ProjectCommandToolError extends Error {
  readonly details: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "ProjectCommandToolError";
    this.details = details;
  }
}

function invalidRequest(): ProjectCommandToolError {
  return new ProjectCommandToolError("Project command request is invalid");
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
    throw invalidRequest();
  }
  const definition = matches[0];
  if (definition === undefined) {
    throw invalidRequest();
  }
  return definition;
}

function validateRequestKeys(keys: readonly string[], commandId: string): void {
  const expectedKeys =
    commandId === "node_test"
      ? ["commandId", "paths"]
      : commandId === "fallow_audit"
        ? ["commandId", "base"]
        : ["commandId"];
  if (!keys.includes("commandId") || keys.some((key) => !expectedKeys.includes(key))) {
    throw invalidRequest();
  }
}

function normalizedRequest(
  params: Record<string, unknown>,
  commandId: string,
): { readonly commandId: string; readonly paths?: readonly string[]; readonly base?: string } {
  if (commandId === "fallow_audit") {
    return { commandId, base: validateProjectCommandRevision(params.base) };
  }
  if (commandId !== "node_test") {
    return { commandId };
  }
  const paths = validateNodeTestPaths(params.paths);
  return paths.length === 0 ? { commandId } : { commandId, paths };
}

export function validateProjectCommandInput(params: unknown): ProjectCommandInput;
export function validateProjectCommandInput<
  const Definitions extends readonly ProjectCommandDefinition[],
>(params: unknown, definitions: Definitions): ProjectCommandInputFor<Definitions>;
export function validateProjectCommandInput(
  params: unknown,
  definitions: readonly ProjectCommandDefinition[] = getProjectCommandDefinitions(),
): { readonly commandId: string; readonly paths?: readonly string[] } {
  try {
    if (!isRecord(params)) {
      throw invalidRequest();
    }
    const request = params;
    const commandId = request.commandId;
    if (typeof commandId !== "string") {
      throw invalidRequest();
    }
    findDefinition(commandId, definitions);
    validateRequestKeys(Object.keys(request), commandId);
    return normalizedRequest(request, commandId);
  } catch (error) {
    if (error instanceof ProjectCommandToolError) {
      throw error;
    }
    throw invalidRequest();
  }
}

export function cancellationError(details?: unknown): ProjectCommandToolError {
  const error = new ProjectCommandToolError("Project command request cancelled", details);
  error.name = "AbortError";
  return error;
}
