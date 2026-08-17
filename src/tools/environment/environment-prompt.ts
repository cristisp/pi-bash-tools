import { promptWithTimeout, type TimedPromptResult } from "../confirmation-prompt.ts";
import type { EnvironmentToolContext } from "./environment-tool.ts";
import type { EnvironmentPolicyAuthorization } from "./policy.ts";
import { EnvironmentToolError } from "./environment-schema.ts";

const ENVIRONMENT_PROMPT_CHOICES = [
  "Deny globally",
  "Deny for this project",
  "Allow globally",
  "Allow for this project",
] as const;

export type EnvironmentPromptResult = TimedPromptResult;

export function cancellationError(): EnvironmentToolError {
  const error = new EnvironmentToolError("Environment request cancelled");
  error.name = "AbortError";
  return error;
}

export function decisionForPromptChoice(
  choice: string,
): Exclude<EnvironmentPolicyAuthorization, "unknown"> {
  switch (choice) {
    case "Deny globally":
      return "deny-global";
    case "Deny for this project":
      return "deny-project";
    case "Allow globally":
      return "allow-global";
    case "Allow for this project":
      return "allow-project";
    default:
      throw new EnvironmentToolError("Environment confirmation returned an invalid choice");
  }
}

export function promptForEnvironmentAccess(
  ctx: EnvironmentToolContext,
  key: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<EnvironmentPromptResult> {
  return promptWithTimeout(
    (dialogSignal) =>
      ctx.ui.select(
        `Authorize access to environment variable ${key}`,
        [...ENVIRONMENT_PROMPT_CHOICES],
        { signal: dialogSignal },
      ),
    timeoutMs,
    signal,
  );
}
