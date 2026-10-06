import { Type } from "typebox";

import { truncationSchema, type Truncation } from "../../truncation.ts";

export interface GitStatusEntry {
  readonly path: string;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
  readonly renamedFrom?: string;
}

export interface GitStatusChangedOutput {
  readonly repositoryRoot: string;
  readonly unchanged: false;
  readonly entries: readonly GitStatusEntry[];
  readonly head?: string;
  readonly dirtyFilesDigest?: string;
  readonly output: Truncation;
}

export interface GitStatusUnchangedOutput {
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

export type GitStatusOutput = GitStatusChangedOutput | GitStatusUnchangedOutput;

export const gitStatusEntrySchema = Type.Object(
  {
    path: Type.String({ description: "Workspace-relative path of the changed file." }),
    indexStatus: Type.String({ description: "Git index status column." }),
    worktreeStatus: Type.String({ description: "Git worktree status column." }),
    renamedFrom: Type.Optional(
      Type.String({ description: "Original path for renamed and copied entries." }),
    ),
  },
  { additionalProperties: false },
);

export const gitStatusOutputSchema = Type.Union(
  [
    Type.Object(
      {
        repositoryRoot: Type.String({ description: "Absolute path of the repository root." }),
        unchanged: Type.Literal(false),
        entries: Type.Array(gitStatusEntrySchema, {
          description: "Changed paths, bounded by the status output limit.",
        }),
        head: Type.Optional(Type.String({ description: "Current HEAD commit when readable." })),
        dirtyFilesDigest: Type.Optional(
          Type.String({ description: "SHA-256 digest of the observed dirty-file identities." }),
        ),
        output: truncationSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        repositoryRoot: Type.String({ description: "Absolute path of the repository root." }),
        unchanged: Type.Literal(true),
        previous: Type.Object(
          {
            digest: Type.String({ description: "SHA-256 digest of the previous status bytes." }),
            entryCount: Type.Integer({ description: "Previous status record count.", minimum: 0 }),
            head: Type.Optional(Type.String({ description: "Previous HEAD commit when read." })),
            dirtyFilesDigest: Type.Optional(
              Type.String({ description: "Previous dirty-file identities digest." }),
            ),
            output: truncationSchema,
          },
          { additionalProperties: false },
        ),
        output: truncationSchema,
        message: Type.String({ description: "Guidance for repeating the request." }),
      },
      { additionalProperties: false },
    ),
  ],
  {
    description:
      "Bounded Git working tree status payload, also returned as the model-facing JSON text.",
  },
);
