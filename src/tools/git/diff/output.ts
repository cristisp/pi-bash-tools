import type { Truncation } from "../../truncation.ts";
import type { GitStatusEntry } from "../status/output.ts";

export interface GitDiffHunk {
  readonly path: string;
  readonly header: string;
}

export interface GitDiffSummaryOutput {
  readonly mode: "summary";
  readonly status: readonly GitStatusEntry[];
  readonly stat: string;
  readonly hunks: readonly GitDiffHunk[];
  readonly output: Truncation;
  readonly message: string;
}

export interface GitDiffPatchOutput {
  readonly mode: "patch";
  readonly patch: string;
  readonly output: Truncation;
  readonly message?: string;
}

export type GitDiffOutput = GitDiffSummaryOutput | GitDiffPatchOutput;
