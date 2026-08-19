import { Type, type Static } from "typebox";
import { getProjectCommandDefinition } from "./definitions.ts";

export const projectCommandInputSchema = Type.Object(
  {
    commandId: Type.Union([
      Type.Literal("workspace_path", {
        description:
          "Report the canonical project directory. Use when the user asks where the project workspace is located.",
      }),
      Type.Literal("node_version", {
        description:
          "Report the Node.js runtime version. Use when the user asks which Node.js version is active.",
      }),
    ]),
  },
  { additionalProperties: false },
);

export type ProjectCommandInput = Static<typeof projectCommandInputSchema>;

export class ProjectCommandToolError extends Error {
  readonly details: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "ProjectCommandToolError";
    this.details = details;
  }
}

export function validateProjectCommandInput(params: unknown): ProjectCommandInput {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new ProjectCommandToolError("Project command request is invalid");
  }
  const keys = Object.keys(params);
  if (keys.length !== 1 || keys[0] !== "commandId") {
    throw new ProjectCommandToolError("Project command request is invalid");
  }
  const commandId = (params as { readonly commandId?: unknown }).commandId;
  if (typeof commandId !== "string") {
    throw new ProjectCommandToolError("Project command request is invalid");
  }
  const definition = getProjectCommandDefinition(commandId);
  if (definition === undefined) {
    throw new ProjectCommandToolError("Project command request is invalid");
  }
  return { commandId: definition.commandId };
}

export function cancellationError(details?: unknown): ProjectCommandToolError {
  const error = new ProjectCommandToolError("Project command request cancelled", details);
  error.name = "AbortError";
  return error;
}
