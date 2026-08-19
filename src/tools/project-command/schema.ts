import { Type, type Static, type TLiteral, type TObject, type TUnion } from "typebox";
import {
  getProjectCommandDefinitions,
  type ProjectCommandDefinition,
  type ProjectCommandId,
} from "./definitions.ts";

export type ProjectCommandInputSchema<
  Definitions extends readonly ProjectCommandDefinition[] =
    readonly ProjectCommandDefinition<ProjectCommandId>[],
> = TObject<{
  commandId: TUnion<[TLiteral<Definitions[number]["commandId"]>]>;
}>;

export type ProjectCommandInputFor<Definitions extends readonly ProjectCommandDefinition[]> =
  Static<ProjectCommandInputSchema<Definitions>>;

type ProjectCommandRuntimeInputSchema = TObject<{
  commandId: TUnion<[] | [TLiteral<string>, ...TLiteral<string>[]]>;
}>;

export function createProjectCommandInputSchema<
  const Definitions extends readonly ProjectCommandDefinition[],
>(definitions: Definitions): ProjectCommandInputSchema<Definitions>;
export function createProjectCommandInputSchema(
  definitions: readonly ProjectCommandDefinition[],
): ProjectCommandRuntimeInputSchema;
export function createProjectCommandInputSchema(
  definitions: readonly ProjectCommandDefinition[],
): ProjectCommandRuntimeInputSchema {
  const literals = definitions.map((definition) =>
    Type.Literal(definition.commandId, { description: definition.description }),
  );
  const commandId =
    literals.length === 0 ? Type.Union([]) : Type.Union([literals[0], ...literals.slice(1)]);
  return Type.Object({ commandId }, { additionalProperties: false });
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

export function validateProjectCommandInput(params: unknown): ProjectCommandInput;
export function validateProjectCommandInput<
  const Definitions extends readonly ProjectCommandDefinition[],
>(params: unknown, definitions: Definitions): ProjectCommandInputFor<Definitions>;
export function validateProjectCommandInput(
  params: unknown,
  definitions: readonly ProjectCommandDefinition[] = getProjectCommandDefinitions(),
): { readonly commandId: string } {
  try {
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      throw new ProjectCommandToolError("Project command request is invalid");
    }
    const keys = Object.keys(params);
    if (keys.length !== 1 || keys[0] !== "commandId") {
      throw new ProjectCommandToolError("Project command request is invalid");
    }
    const commandId = (params as { readonly commandId?: unknown }).commandId;
    if (typeof commandId !== "string") {
      throw new ProjectCommandToolError("Project command request is invalid");
    }
    let definition: ProjectCommandDefinition | undefined;
    for (const candidate of definitions) {
      if (candidate.commandId !== commandId) {
        continue;
      }
      if (definition !== undefined) {
        throw new ProjectCommandToolError("Project command request is invalid");
      }
      definition = candidate;
    }
    if (definition === undefined) {
      throw new ProjectCommandToolError("Project command request is invalid");
    }
    return { commandId: definition.commandId };
  } catch (error) {
    if (error instanceof ProjectCommandToolError) {
      throw error;
    }
    throw new ProjectCommandToolError("Project command request is invalid");
  }
}

export function cancellationError(details?: unknown): ProjectCommandToolError {
  const error = new ProjectCommandToolError("Project command request cancelled", details);
  error.name = "AbortError";
  return error;
}
