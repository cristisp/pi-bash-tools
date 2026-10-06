import { Type } from "typebox";

export interface EnvironmentOutput {
  readonly values: Readonly<Record<string, string | null>>;
}

export const environmentOutputSchema = Type.Object(
  {
    values: Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]), {
      description: "Requested key mapped to its string value, or null when unset.",
    }),
  },
  {
    additionalProperties: false,
    description:
      "Environment read payload, also returned as the model-facing JSON text. Failures throw and carry no structured content.",
  },
);
