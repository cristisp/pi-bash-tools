import { Type, type Static, type TObject, type TUnion } from "typebox";
import {
  getProjectCommandDefinitions,
  type ProjectCommandDefinition,
  type ProjectCommandId,
} from "./definitions.ts";
import { FALLOW_REVISION_PATTERN, NODE_TEST_PATH_PATTERN } from "./parameters.ts";

export {
  cancellationError,
  ProjectCommandToolError,
  validateProjectCommandInput,
} from "./schema/validation.ts";

export type ProjectCommandInputSchema<
  Definitions extends readonly ProjectCommandDefinition[] =
    readonly ProjectCommandDefinition<ProjectCommandId>[],
> = Definitions extends readonly ProjectCommandDefinition[] ? TUnion : never;

type InputForDefinition<Definition extends ProjectCommandDefinition> =
  Definition extends ProjectCommandDefinition
    ? Definition["commandId"] extends "node_test"
      ? { readonly commandId: Definition["commandId"]; readonly paths?: readonly string[] }
      : Definition["commandId"] extends "fallow_audit"
        ? { readonly commandId: Definition["commandId"]; readonly base: string }
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
  if (definition.commandId === "fallow_audit") {
    return Type.Object(
      {
        commandId,
        base: Type.String({
          pattern: FALLOW_REVISION_PATTERN,
          description: "Required safe revision used as the Fallow audit base.",
        }),
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
