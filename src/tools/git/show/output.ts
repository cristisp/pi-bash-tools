import type { Truncation } from "../../truncation.ts";

export interface GitShowOutput {
  readonly content: string;
  readonly output: Truncation;
}
