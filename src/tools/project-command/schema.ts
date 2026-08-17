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
  try {
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      throw new ProjectCommandToolError("Project command request is invalid");
    }
    const prototype = Object.getPrototypeOf(params);
    const keys = Reflect.ownKeys(params);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.length !== 1 ||
      keys[0] !== "commandId"
    ) {
      throw new ProjectCommandToolError("Project command request is invalid");
    }
    const descriptor = Object.getOwnPropertyDescriptor(params, "commandId");
    const commandId = descriptor?.value;
    const definition =
      typeof commandId === "string" ? getProjectCommandDefinition(commandId) : undefined;
    if (descriptor === undefined || !("value" in descriptor) || definition === undefined) {
      throw new ProjectCommandToolError("Project command request is invalid");
    }
    return { commandId: definition.commandId };
  } catch (error) {
    if (error instanceof ProjectCommandToolError) {
      throw error;
    }
    throw new ProjectCommandToolError("Project command request is invalid");
  }
}

export function cancellationError(details?: unknown): ProjectCommandToolError {
  const error = new ProjectCommandToolError("Project command request cancelled", details);
  error.name = "AbortError";
  return error;
}
