import { Type } from "typebox";

import { truncationSchema, type Truncation } from "../../truncation.ts";

export interface GitShowOutput {
  readonly content: string;
  readonly output: Truncation;
}

export const gitShowOutputSchema = Type.Object(
  {
    content: Type.String({ description: "Bounded revision output text." }),
    output: truncationSchema,
  },
  {
    additionalProperties: false,
    description:
      "Bounded Git revision output payload, also returned as the model-facing JSON text.",
  },
);
