import { Type } from "typebox";

import { truncationSchema, type Truncation } from "../../truncation.ts";

export interface GitLogEntry {
  readonly id: string;
  readonly author: string;
  readonly date: string;
  readonly subject: string;
}

export interface GitLogOutput {
  readonly entries: readonly GitLogEntry[];
  readonly output: Truncation;
}

const gitLogEntrySchema = Type.Object(
  {
    id: Type.String({ description: "Full commit SHA." }),
    author: Type.String({ description: "Author name." }),
    date: Type.String({ description: "Author date in strict ISO-8601 format." }),
    subject: Type.String({ description: "Commit subject." }),
  },
  { additionalProperties: false },
);

export const gitLogOutputSchema = Type.Object(
  {
    entries: Type.Array(gitLogEntrySchema, { description: "Commits, newest first, bounded." }),
    output: truncationSchema,
  },
  {
    additionalProperties: false,
    description: "Bounded Git commit history payload, also returned as the model-facing JSON text.",
  },
);
