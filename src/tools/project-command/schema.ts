import { Type, type Static, type TObject, type TUnion } from "typebox";
import {
  getProjectCommandDefinitions,
  type ProjectCommandDefinition,
  type ProjectCommandId,
} from "./definitions.ts";
import {
  FALLOW_REVISION_PATTERN,
  NODE_E2E_GREP_MAX_LENGTH,
  NODE_E2E_GREP_PATTERN,
  NODE_E2E_PROJECT_MAX_LENGTH,
  NODE_E2E_PROJECT_PATTERN,
  NODE_TEST_PATH_PATTERN,
  PROJECT_COMMAND_MAX_FORWARDED_ARGUMENT_BYTES,
  PROJECT_COMMAND_MAX_PARAMETER_ITEMS,
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
          readonly force?: boolean;
          readonly paths?: readonly string[];
        }
      : Definition["commandId"] extends "node_e2e"
        ? {
            readonly commandId: Definition["commandId"];
            readonly force?: boolean;
            readonly paths?: readonly string[];
            readonly grep?: string;
            readonly projects?: readonly string[];
            readonly workers?: number;
            readonly retries?: number;
            readonly headed?: boolean;
            readonly list?: boolean;
          }
        : Definition["commandId"] extends "fallow_audit"
          ? {
              readonly commandId: Definition["commandId"];
              readonly force?: boolean;
              readonly base: string;
            }
          : { readonly commandId: Definition["commandId"]; readonly force?: boolean }
    : never;

export type ProjectCommandInputFor<Definitions extends readonly ProjectCommandDefinition[]> =
  InputForDefinition<Definitions[number]>;

type ProjectCommandRuntimeInputSchema = TUnion;

function variantForDefinition(definition: ProjectCommandDefinition): TObject {
  const commandId = Type.Literal(definition.commandId, { description: definition.description });
  const force = Type.Optional(
    Type.Boolean({ description: "Bypass a reusable result cache for this invocation." }),
  );
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
  if (definition.commandId === "node_e2e") {
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
            {
              maxItems: PROJECT_COMMAND_MAX_PARAMETER_ITEMS,
              description: "Optional workspace-relative E2E test paths.",
            },
          ),
        ),
        grep: Type.Optional(
          Type.String({
            pattern: NODE_E2E_GREP_PATTERN,
            maxLength: NODE_E2E_GREP_MAX_LENGTH,
            description: "Optional test title filter.",
          }),
        ),
        projects: Type.Optional(
          Type.Array(
            Type.String({
              pattern: NODE_E2E_PROJECT_PATTERN,
              maxLength: NODE_E2E_PROJECT_MAX_LENGTH,
            }),
            {
              maxItems: PROJECT_COMMAND_MAX_PARAMETER_ITEMS,
              description: "Optional test runner project names.",
            },
          ),
        ),
        workers: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 64, description: "Optional worker limit." }),
        ),
        retries: Type.Optional(
          Type.Integer({ minimum: 0, maximum: 10, description: "Optional retry limit." }),
        ),
        headed: Type.Optional(Type.Boolean({ description: "Run with visible browsers." })),
        list: Type.Optional(Type.Boolean({ description: "Collect tests without running them." })),
      },
      {
        additionalProperties: false,
        description: `Forwarded E2E arguments are limited to ${PROJECT_COMMAND_MAX_FORWARDED_ARGUMENT_BYTES} bytes.`,
      },
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
