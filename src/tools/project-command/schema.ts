import { Type, type Static, type TObject, type TUnion } from "typebox";
import { booleanInputSchema, type BooleanInput } from "../boolean.ts";
import {
  getProjectCommandDefinitions,
  type ProjectCommandDefinition,
  type ProjectCommandId,
} from "./definitions.ts";
import {
  FALLOW_REVISION_PATTERN,
  NODE_TEST_PATH_PATTERN,
  PROJECT_COMMAND_MAX_PARAMETER_ITEMS,
  PROJECT_COMMAND_MAX_SCRIPT_VARIANT_LENGTH,
  PROJECT_COMMAND_SCRIPT_VARIANT_PATTERN,
  PROJECT_COMMAND_MAX_PATH_LENGTH,
} from "./parameters.ts";

export {
  cancellationError,
  invalidRequest,
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
      ? {
          readonly commandId: Definition["commandId"];
          readonly force?: BooleanInput;
          readonly paths?: readonly string[];
          readonly variant?: string;
        }
      : Definition["commandId"] extends "node_lint"
        ? {
            readonly commandId: Definition["commandId"];
            readonly force?: BooleanInput;
            readonly variant?: string;
          }
        : Definition["commandId"] extends "node_format"
          ? {
              readonly commandId: Definition["commandId"];
              readonly force?: BooleanInput;
              readonly variant?: string;
            }
          : Definition["commandId"] extends "fallow_audit"
            ? {
                readonly commandId: Definition["commandId"];
                readonly force?: BooleanInput;
                readonly base: string;
              }
            : { readonly commandId: Definition["commandId"]; readonly force?: BooleanInput }
    : never;

export type ProjectCommandInputFor<Definitions extends readonly ProjectCommandDefinition[]> =
  InputForDefinition<Definitions[number]>;

type ProjectCommandRuntimeInputSchema = TUnion;

function legacyVariantCommandId(commandId: string) {
  return Type.String({
    pattern: `^${commandId}:${PROJECT_COMMAND_SCRIPT_VARIANT_PATTERN.slice(1)}`,
    maxLength: PROJECT_COMMAND_MAX_SCRIPT_VARIANT_LENGTH + commandId.length + 1,
    description: `Legacy alias for ${commandId} with the package-script variant embedded in commandId.`,
  });
}

function legacyVariantForDefinition(definition: ProjectCommandDefinition): TObject | undefined {
  if (
    definition.commandId !== "node_test" &&
    definition.commandId !== "node_lint" &&
    definition.commandId !== "node_format"
  ) {
    return undefined;
  }
  const commandId = legacyVariantCommandId(definition.commandId);
  const force = Type.Optional(booleanInputSchema);
  if (definition.commandId === "node_test") {
    return Type.Object(
      {
        commandId,
        force,
        paths: Type.Optional(
          Type.Array(
            Type.String({
              pattern: NODE_TEST_PATH_PATTERN,
              maxLength: PROJECT_COMMAND_MAX_PATH_LENGTH,
            }),
            { maxItems: PROJECT_COMMAND_MAX_PARAMETER_ITEMS },
          ),
        ),
      },
      { additionalProperties: false },
    );
  }
  return Type.Object({ commandId, force }, { additionalProperties: false });
}

function variantForDefinition(definition: ProjectCommandDefinition): TObject {
  const commandId = Type.Literal(definition.commandId, { description: definition.description });
  const force = Type.Optional(booleanInputSchema);
  if (definition.commandId === "node_test") {
    return Type.Object(
      {
        commandId,
        force,
        variant: Type.Optional(
          Type.String({
            pattern: PROJECT_COMMAND_SCRIPT_VARIANT_PATTERN,
            maxLength: PROJECT_COMMAND_MAX_SCRIPT_VARIANT_LENGTH,
            description: "Optional validated suffix for an existing test:<variant> package script.",
          }),
        ),
        paths: Type.Optional(
          Type.Array(
            Type.String({
              pattern: NODE_TEST_PATH_PATTERN,
              maxLength: PROJECT_COMMAND_MAX_PATH_LENGTH,
            }),
            {
              maxItems: PROJECT_COMMAND_MAX_PARAMETER_ITEMS,
              description: "Optional workspace-relative test paths.",
            },
          ),
        ),
      },
      { additionalProperties: false },
    );
  }
  if (definition.commandId === "node_lint") {
    return Type.Object(
      {
        commandId,
        force,
        variant: Type.Optional(
          Type.String({
            pattern: PROJECT_COMMAND_SCRIPT_VARIANT_PATTERN,
            maxLength: PROJECT_COMMAND_MAX_SCRIPT_VARIANT_LENGTH,
            description: "Optional validated suffix for an existing lint:<variant> package script.",
          }),
        ),
      },
      { additionalProperties: false },
    );
  }
  if (definition.commandId === "node_format") {
    return Type.Object(
      {
        commandId,
        force,
        variant: Type.Optional(
          Type.String({
            pattern: PROJECT_COMMAND_SCRIPT_VARIANT_PATTERN,
            maxLength: PROJECT_COMMAND_MAX_SCRIPT_VARIANT_LENGTH,
            description:
              "Optional validated suffix for an existing format:<variant> package script.",
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
        force,
        base: Type.String({
          pattern: FALLOW_REVISION_PATTERN,
          description: "Required safe revision used as the Fallow audit base.",
        }),
      },
      { additionalProperties: false },
    );
  }
  return Type.Object({ commandId, force }, { additionalProperties: false });
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
  const variants = [
    ...definitions.map((definition) => variantForDefinition(definition)),
    ...definitions.flatMap((definition) => {
      const legacy = legacyVariantForDefinition(definition);
      return legacy === undefined ? [] : [legacy];
    }),
  ];
  if (variants.length === 0) {
    return Type.Union([Type.Never()]);
  }
  return Type.Union(variants);
}

export const projectCommandInputSchema = createProjectCommandInputSchema(
  getProjectCommandDefinitions(),
);

export type ProjectCommandInput = Static<typeof projectCommandInputSchema>;
