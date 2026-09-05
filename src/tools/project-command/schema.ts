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

export type ProjectCommandEvidenceLookup = {
  readonly ref: string;
  readonly flowId?: string;
  readonly covers?: readonly string[];
};

type EvidenceExecutionOptions = {
  readonly publish?: { readonly flowId: string };
  readonly covers?: readonly string[];
};

type InputForDefinition<Definition extends ProjectCommandDefinition> =
  Definition extends ProjectCommandDefinition
    ? Definition["commandId"] extends "node_test"
      ? {
          readonly commandId: Definition["commandId"];
          readonly force?: BooleanInput;
          readonly paths?: readonly string[];
          readonly variant?: string;
        } & EvidenceExecutionOptions
      : Definition["commandId"] extends "node_lint"
        ? {
            readonly commandId: Definition["commandId"];
            readonly force?: BooleanInput;
            readonly variant?: string;
          } & EvidenceExecutionOptions
        : Definition["commandId"] extends "node_format"
          ? {
              readonly commandId: Definition["commandId"];
              readonly force?: BooleanInput;
              readonly variant?: string;
            } & EvidenceExecutionOptions
          : Definition["commandId"] extends "fallow_audit"
            ? {
                readonly commandId: Definition["commandId"];
                readonly force?: BooleanInput;
                readonly base: string;
              } & EvidenceExecutionOptions
            : {
                readonly commandId: Definition["commandId"];
                readonly force?: BooleanInput;
              } & EvidenceExecutionOptions
    : never;

export type ProjectCommandInputFor<Definitions extends readonly ProjectCommandDefinition[]> =
  | InputForDefinition<Definitions[number]>
  | ProjectCommandEvidenceLookup;

type ProjectCommandRuntimeInputSchema = TUnion;

const evidenceProperties = () => ({
  publish: Type.Optional(
    Type.Object(
      { flowId: Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }) },
      { additionalProperties: false, description: "Publish evidence to an authorized flow." },
    ),
  ),
  covers: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
      maxItems: 64,
      description: "Opaque acceptance-criteria identifiers to preserve in evidence.",
    }),
  ),
});

function lookupEvidenceSchema(): TObject {
  return Type.Object(
    {
      ref: Type.String({
        pattern: "^[A-Za-z0-9_-]{8,128}$",
        description: "Lookup-only evidence reference.",
      }),
      flowId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" })),
      covers: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
          maxItems: 64,
          description: "Opaque acceptance-criteria identifiers to preserve in evidence.",
        }),
      ),
    },
    { additionalProperties: false },
  );
}

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
        ...evidenceProperties(),
        paths: Type.Optional(
          Type.Union([
            Type.Array(
              Type.String({
                pattern: NODE_TEST_PATH_PATTERN,
                maxLength: PROJECT_COMMAND_MAX_PATH_LENGTH,
              }),
              { maxItems: PROJECT_COMMAND_MAX_PARAMETER_ITEMS },
            ),
            Type.String({
              description:
                'JSON array of workspace-relative test paths, for example ["src/index.ts"].',
            }),
          ]),
        ),
      },
      { additionalProperties: false },
    );
  }
  return Type.Object(
    { commandId, force, ...evidenceProperties() },
    { additionalProperties: false },
  );
}

function variantForDefinition(definition: ProjectCommandDefinition): TObject {
  const commandId = Type.Literal(definition.commandId, { description: definition.description });
  const force = Type.Optional(booleanInputSchema);
  if (definition.commandId === "node_test") {
    return Type.Object(
      {
        commandId,
        force,
        ...evidenceProperties(),
        variant: Type.Optional(
          Type.String({
            pattern: PROJECT_COMMAND_SCRIPT_VARIANT_PATTERN,
            maxLength: PROJECT_COMMAND_MAX_SCRIPT_VARIANT_LENGTH,
            description: "Optional validated suffix for an existing test:<variant> package script.",
          }),
        ),
        paths: Type.Optional(
          Type.Union([
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
            Type.String({
              description:
                'JSON array of workspace-relative test paths, for example ["src/index.ts"].',
            }),
          ]),
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
        ...evidenceProperties(),
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
        ...evidenceProperties(),
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
        ...evidenceProperties(),
        base: Type.String({
          pattern: FALLOW_REVISION_PATTERN,
          description: "Required safe revision used as the Fallow audit base.",
        }),
      },
      { additionalProperties: false },
    );
  }
  return Type.Object(
    { commandId, force, ...evidenceProperties() },
    { additionalProperties: false },
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
  const variants = [
    ...definitions.map((definition) => variantForDefinition(definition)),
    ...definitions.flatMap((definition) => {
      const legacy = legacyVariantForDefinition(definition);
      return legacy === undefined ? [] : [legacy];
    }),
    lookupEvidenceSchema(),
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
