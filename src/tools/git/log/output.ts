import type { Truncation } from "../../truncation.ts";

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
