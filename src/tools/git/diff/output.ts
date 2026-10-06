import { Type } from "typebox";

import { truncationSchema, type Truncation } from "../../truncation.ts";
import { gitStatusEntrySchema, type GitStatusEntry } from "../status/output.ts";

export interface GitDiffHunk {
  readonly path: string;
  readonly header: string;
}

export interface GitDiffSummaryOutput {
  readonly mode: "summary";
  readonly status: readonly GitStatusEntry[];
  readonly stat: string;
  readonly hunks: readonly GitDiffHunk[];
  readonly head?: string;
  readonly dirtyFilesDigest?: string;
  readonly output: Truncation;
  readonly message: string;
}

export interface GitDiffSummaryUnchangedOutput {
  readonly mode: "summary";
  readonly repositoryRoot: string;
  readonly unchanged: true;
  readonly previous: {
    readonly digest: string;
    readonly entryCount: number;
    readonly head?: string;
    readonly dirtyFilesDigest?: string;
    readonly output: Pick<Truncation, "totalBytes" | "totalLines" | "truncated">;
  };
  readonly output: Truncation;
  readonly message: string;
}

export interface GitDiffPatchOutput {
  readonly mode: "patch";
  readonly patch: string;
  readonly output: Truncation;
  readonly message?: string;
}

export type GitDiffOutput =
  | GitDiffSummaryOutput
  | GitDiffSummaryUnchangedOutput
  | GitDiffPatchOutput;

const gitDiffHunkSchema = Type.Object(
  {
    path: Type.String({ description: "File path of the hunk." }),
    header: Type.String({ description: "Hunk header line without the body." }),
  },
  { additionalProperties: false },
);

const gitDiffSummaryPreviousSchema = Type.Object(
  {
    digest: Type.String({ description: "SHA-256 digest of the previous summary state." }),
    entryCount: Type.Integer({ description: "Previous status record count.", minimum: 0 }),
    head: Type.Optional(Type.String({ description: "Previous HEAD commit." })),
    dirtyFilesDigest: Type.Optional(
      Type.String({ description: "Previous digest of dirty-file identities." }),
    ),
    output: truncationSchema,
  },
  { additionalProperties: false },
);

export const gitDiffOutputSchema = Type.Union(
  [
    Type.Object(
      {
        mode: Type.Literal("summary"),
        status: Type.Array(gitStatusEntrySchema, {
          description: "Status entries, bounded by the status record cap.",
        }),
        stat: Type.String({ description: "Per-file diff stat." }),
        hunks: Type.Array(gitDiffHunkSchema, { description: "Hunk headers without bodies." }),
        head: Type.Optional(Type.String({ description: "Current HEAD commit." })),
        dirtyFilesDigest: Type.Optional(
          Type.String({ description: "SHA-256 digest of the observed dirty-file identities." }),
        ),
        output: truncationSchema,
        message: Type.String({ description: "Guidance for follow-up requests." }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        mode: Type.Literal("summary"),
        repositoryRoot: Type.String({ description: "Absolute path of the repository root." }),
        unchanged: Type.Literal(true),
        previous: gitDiffSummaryPreviousSchema,
        output: truncationSchema,
        message: Type.String({ description: "Guidance for requesting full content." }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        mode: Type.Literal("patch"),
        patch: Type.String({ description: "Bounded patch content." }),
        output: truncationSchema,
        message: Type.Optional(
          Type.String({ description: "Present when the patch was truncated." }),
        ),
      },
      { additionalProperties: false },
    ),
  ],
  {
    description:
      "Bounded Git diff payload (summary, unchanged comparison, or patch), also returned as the model-facing JSON text.",
  },
);
