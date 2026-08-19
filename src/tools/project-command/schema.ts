import { Type, type Static, type TObject, type TUnion } from "typebox";
import {
  getProjectCommandDefinitions,
  type ProjectCommandDefinition,
  type ProjectCommandId,
} from "./definitions.ts";
import { NODE_TEST_PATH_PATTERN, validateNodeTestPaths } from "./parameters.ts";

export type ProjectCommandInputSchema<
  Definitions extends readonly ProjectCommandDefinition[] =
    readonly ProjectCommandDefinition<ProjectCommandId>[],
> = Definitions extends readonly ProjectCommandDefinition[] ? TUnion : never;

type InputForDefinition<Definition extends ProjectCommandDefinition> =
  Definition extends ProjectCommandDefinition
    ? Definition["commandId"] extends "node_test"
      ? { readonly commandId: Definition["commandId"]; readonly paths?: readonly string[] }
      : { readonly commandId: Definition["commandId"] }
    : never;

export type ProjectCommandInputFor<Definitions extends readonly ProjectCommandDefinition[]> =
  InputForDefinition<Definitions[number]>;

type ProjectCommandRuntimeInputSchema = TUnion;

function variantForDefinition(definition: ProjectCommandDefinition): TObject {
  const commandId = Type.Literal(definition.commandId, { description: definition.description });
  if (definition.commandId === "node_test") {
    return Type.Object(
      {
        commandId,
        paths: Type.Optional(
          Type.Array(Type.String({ pattern: NODE_TEST_PATH_PATTERN }), {
            description: "Optional workspace-relative test paths.",
          }),
        ),
      },
      { additionalProperties: false },
    );
  }
  return Type.Object({ commandId }, { additionalProperties: false });
}

export function createProjectCommandInputSchema<
  const Definitions extends readonly ProjectCommandDefinition[],
>(definitions: Definitions): ProjectCommandInputSchema<Definitions>;
export function createProjectCommandInputSchema(
  definitions: readonly ProjectCommandDefinition[],
): ProjectCommandRuntimeInputSchema;
export function createProjectCommandInputSchema(
  definitions: readonly ProjectCommandDefinition[],
): ProjectCommandRuntimeInputSchema {
  const variants = definitions.map(variantForDefinition);
  if (variants.length === 0) {
    return Type.Union([Type.Never()]);
  }
  return Type.Union(variants);
}

export const projectCommandInputSchema = createProjectCommandInputSchema(
  getProjectCommandDefinitions(),
);

export type ProjectCommandInput = Static<typeof projectCommandInputSchema>;

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
  const expectedKeys = commandId === "node_test" ? ["commandId", "paths"] : ["commandId"];
  if (!keys.includes("commandId") || keys.some((key) => !expectedKeys.includes(key))) {
    throw invalidRequest();
  }
}

function normalizedRequest(
  params: Record<string, unknown>,
  commandId: string,
): { readonly commandId: string; readonly paths?: readonly string[] } {
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
