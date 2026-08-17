import type { Truncation } from "../../truncation.ts";

export interface GitDiffOutput {
  readonly patch: string;
  readonly output: Truncation;
}
