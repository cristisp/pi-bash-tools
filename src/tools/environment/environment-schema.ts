import { Type, type Static } from "typebox";
import {
  createToolErrorContract,
  suggestedActionForCategory,
  withToolErrorContract,
  type ResultCategory,
  type ToolErrorContract,
} from "../errors.ts";
import { ENVIRONMENT_VARIABLE_NAME_PATTERN } from "../policy/format.ts";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class EnvironmentToolError extends Error {
  readonly details: unknown;
  readonly contract: ToolErrorContract;

  constructor(message: string, details?: unknown, contract?: ToolErrorContract) {
    super(message);
    this.name = "EnvironmentToolError";
    this.contract =
      contract ??
      createToolErrorContract({
        code: "environment-error",
        category: "IMPLEMENTATION_FAILURE",
        explanation: message,
        suggestedAction: suggestedActionForCategory("IMPLEMENTATION_FAILURE"),
        retryable: true,
        executed: false,
      });
    this.details = isRecord(details)
      ? withToolErrorContract(details, this.contract)
      : withToolErrorContract({}, this.contract);
  }
}

export function environmentContract(
  code: string,
  category: Exclude<ResultCategory, "PASS">,
  explanation: string,
  retryable: boolean,
  executed: boolean,
  invalidField?: string,
): ToolErrorContract {
  return createToolErrorContract({
    code,
    category,
    explanation,
    ...(invalidField === undefined ? {} : { invalidField }),
    suggestedAction: suggestedActionForCategory(category),
    retryable,
    executed,
  });
}

export function environmentError(
  message: string,
  contract: ToolErrorContract,
  name?: string,
): EnvironmentToolError {
  const error = new EnvironmentToolError(message, withToolErrorContract({}, contract), contract);
  if (name !== undefined) {
    error.name = name;
  }
  return error;
}

export function environmentCancellationError(executed = false): EnvironmentToolError {
  return environmentError(
    "Environment request cancelled",
    environmentContract(
      "cancelled",
      "CANCELLED",
      "The environment request was cancelled.",
      true,
      executed,
    ),
    "AbortError",
  );
}

function invalidEnvironmentRequest(): EnvironmentToolError {
  return environmentError(
    "Environment keys must be unique valid variable names",
    environmentContract(
      "invalid-request",
      "INVALID_REQUEST",
      "The environment request contains invalid keys.",
      false,
      false,
      "keys",
    ),
  );
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
