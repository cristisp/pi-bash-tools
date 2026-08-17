import { Type, type Static } from "typebox";
import { ENVIRONMENT_VARIABLE_NAME_PATTERN } from "./policy.ts";

export const environmentInputSchema = Type.Object(
  {
    keys: Type.Array(
      Type.String({
        minLength: 1,
        pattern: ENVIRONMENT_VARIABLE_NAME_PATTERN.source,
      }),
      {
        minItems: 1,
        uniqueItems: true,
        description: "Environment-variable names to read after authorization",
      },
    ),
  },
  { additionalProperties: false },
);

export type EnvironmentInput = Static<typeof environmentInputSchema>;

export class EnvironmentToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentToolError";
  }
}

function invalidEnvironmentRequest(): EnvironmentToolError {
  return new EnvironmentToolError("Environment keys must be unique valid variable names");
}

export function validateEnvironmentKeys(params: EnvironmentInput): readonly string[] {
  if (!params || !Array.isArray(params.keys) || params.keys.length === 0) {
    throw invalidEnvironmentRequest();
  }
  if (
    params.keys.some(
      (key) => typeof key !== "string" || !ENVIRONMENT_VARIABLE_NAME_PATTERN.test(key),
    ) ||
    new Set(params.keys).size !== params.keys.length
  ) {
    throw invalidEnvironmentRequest();
  }
  return params.keys;
}
