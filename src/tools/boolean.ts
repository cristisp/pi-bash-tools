import { Type } from "typebox";

/** Boolean values accepted at the JSON tool boundary. */
export type BooleanInput = boolean | "true" | "false";

/**
 * A deliberately exact conversion for JSON producers that serialize booleans.
 * No trimming, case folding, numeric coercion, or truthiness is allowed.
 */
export function normalizeBooleanInput(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new TypeError(`${label} must be a boolean or the literal string "true" or "false"`);
}

export const booleanInputSchema = Type.Union(
  [Type.Boolean(), Type.Literal("true"), Type.Literal("false")],
  { description: 'Boolean value or the literal string "true" or "false".' },
);
