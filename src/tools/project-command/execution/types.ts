import type { ProjectCommandDefinition } from "../definitions.ts";
import type { ResolvedProjectCommand } from "../resolution/types.ts";

export type ProjectCommandExecutionInput = ResolvedProjectCommand | ProjectCommandDefinition;
