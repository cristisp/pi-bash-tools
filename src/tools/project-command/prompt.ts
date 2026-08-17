import { promptWithTimeout, type TimedPromptResult } from "../confirmation-prompt.ts";
import type { ProjectCommandToolContext } from "./tool.ts";

const PROJECT_COMMAND_PROMPT_CHOICES = [
  "Deny globally",
  "Deny for this project",
  "Allow globally",
  "Allow for this project",
] as const;

export type ProjectCommandPromptResult = TimedPromptResult;

export function projectCommandCanPrompt(
  mode: ProjectCommandToolContext["mode"],
  hasUI: boolean,
  signal: AbortSignal | undefined,
): boolean {
  return hasUI && (mode === "tui" || mode === "rpc") && !signal?.aborted;
}

export function decisionForProjectCommandChoice(
  choice: string,
): "deny-global" | "deny-project" | "allow-global" | "allow-project" {
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
      throw new Error("Project command confirmation returned an invalid choice");
  }
}

export function promptForProjectCommand(
  ctx: ProjectCommandToolContext,
  commandId: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ProjectCommandPromptResult> {
  return promptWithTimeout(
    (dialogSignal) =>
      ctx.ui.select(`Authorize project command ${commandId}`, [...PROJECT_COMMAND_PROMPT_CHOICES], {
        signal: dialogSignal,
      }),
    timeoutMs,
    signal,
  );
}
