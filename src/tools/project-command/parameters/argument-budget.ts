import { PROJECT_COMMAND_MAX_FORWARDED_ARGUMENT_BYTES } from "./limits.ts";

function forwardedArgumentBytes(args: readonly string[]): number {
  let total = 0;
  for (const arg of args) {
    total += Buffer.byteLength(arg, "utf8") + 1;
  }
  return total;
}

export function isWithinForwardedArgumentBudget(args: readonly string[]): boolean {
  return forwardedArgumentBytes(args) <= PROJECT_COMMAND_MAX_FORWARDED_ARGUMENT_BYTES;
}
