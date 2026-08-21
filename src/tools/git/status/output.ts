import type { Truncation } from "../../truncation.ts";

export interface GitStatusEntry {
  readonly path: string;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
  readonly renamedFrom?: string;
}

export interface GitStatusOutput {
  readonly repositoryRoot: string;
  readonly entries: readonly GitStatusEntry[];
  readonly output: Truncation;
}
