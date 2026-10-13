import { Type, type Static, type TObject } from "typebox";

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
> = Definitions extends readonly ProjectCommandDefinition[] ? TObject : never;

type InputForDefinition<Definition extends ProjectCommandDefinition> = {
  readonly commandId: Definition["commandId"];
  readonly force?: BooleanInput | null;
  readonly paths?: readonly string[] | null;
  readonly variant?: string | null;
  readonly base?: string | null;
};

export type ProjectCommandInputFor<Definitions extends readonly ProjectCommandDefinition[]> =
  InputForDefinition<Definitions[number]>;

type ProjectCommandRuntimeInputSchema = TObject;

function legacyVariantCommandId(commandId: string) {
  return Type.String({
    pattern: `^${commandId}:${PROJECT_COMMAND_SCRIPT_VARIANT_PATTERN.slice(1)}`,
    maxLength: PROJECT_COMMAND_MAX_SCRIPT_VARIANT_LENGTH + commandId.length + 1,
    description: `Legacy alias for ${commandId} with the package-script variant embedded in commandId.`,
  });
}

function scriptVariantSchema(description: string) {
  return Type.Optional(
    Type.Union([
      Type.String({
        pattern: PROJECT_COMMAND_SCRIPT_VARIANT_PATTERN,
        maxLength: PROJECT_COMMAND_MAX_SCRIPT_VARIANT_LENGTH,
        description,
      }),
      Type.Null(),
    ]),
  );
}

function testPathsSchema(description?: string) {
  return Type.Optional(
    Type.Union([
      Type.Array(
        Type.String({
          pattern: NODE_TEST_PATH_PATTERN,
          maxLength: PROJECT_COMMAND_MAX_PATH_LENGTH,
        }),
        {
          maxItems: PROJECT_COMMAND_MAX_PARAMETER_ITEMS,
          ...(description === undefined ? {} : { description }),
        },
      ),
      Type.String({
        description: 'JSON array of workspace-relative test paths, for example ["src/index.ts"].',
      }),
      Type.Null(),
    ]),
  );
}

const SCRIPT_VARIANT_COMMAND_IDS = ["node_test", "node_lint", "node_format"];

function commandIdSchema(definitions: readonly ProjectCommandDefinition[]) {
  const commandIds = definitions.map((definition) =>
    Type.Literal(definition.commandId, { description: definition.description }),
  );
  const legacyAliases = definitions
    .filter((definition) => SCRIPT_VARIANT_COMMAND_IDS.includes(definition.commandId))
    .map((definition) => legacyVariantCommandId(definition.commandId));
  return Type.Optional(
    Type.Union([...commandIds, ...legacyAliases, Type.Null()], {
      description: "One fixed command ID for execution requests, or a legacy variant alias.",
    }),
  );
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
  return Type.Object(
    {
      commandId: commandIdSchema(definitions),
      force: Type.Optional(Type.Union([booleanInputSchema, Type.Null()])),
      paths: Type.Optional(
        testPathsSchema("Optional workspace-relative test paths for node_test."),
      ),
      variant: scriptVariantSchema(
        "Optional validated suffix for an existing test:<variant>, lint:<variant>, or format:<variant> package script.",
      ),
      base: Type.Optional(
        Type.Union([
          Type.String({
            pattern: FALLOW_REVISION_PATTERN,
            description: "Required safe revision used as the Fallow audit base.",
          }),
          Type.Null(),
        ]),
      ),
    },
    {
      additionalProperties: false,
      description:
        "Run one fixed command from the registered project command catalog, including fixed Node dependency listings and package scripts and fixed Fallow analyses. Execution requests require commandId and may include force, command-specific fields (paths, variant, or base as applicable to the selected command).",
    },
  );
}

export const projectCommandInputSchema = createProjectCommandInputSchema(
  getProjectCommandDefinitions(),
);

export type ProjectCommandInput = Static<typeof projectCommandInputSchema>;
