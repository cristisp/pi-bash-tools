import type { Truncation } from "../../truncation.ts";

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
  readonly output: Truncation;
}

export interface GitStatusUnchangedOutput {
  readonly repositoryRoot: string;
  readonly unchanged: true;
  readonly previous: {
    readonly digest: string;
    readonly entryCount: number;
    readonly output: Pick<Truncation, "totalBytes" | "totalLines" | "truncated">;
  };
  readonly output: Truncation;
  readonly message: string;
}

export type GitStatusOutput = GitStatusChangedOutput | GitStatusUnchangedOutput;
