import type { ProjectCommandDefinition, ResolvedCommandLine } from "../definitions.ts";

export interface ResolvedProjectCommand extends ResolvedCommandLine {
  readonly definition: ProjectCommandDefinition;
  readonly displayCommand?: string;
  readonly effectiveParameters?: Readonly<Record<string, unknown>>;
  readonly script?: string;
  readonly structuredDetails?: unknown;
}

export type ProjectCommandResolver = (
  definition: ProjectCommandDefinition,
  projectPath: string,
  signal: AbortSignal | undefined,
  parameters?: unknown,
) => ResolvedProjectCommand | Promise<ResolvedProjectCommand>;
