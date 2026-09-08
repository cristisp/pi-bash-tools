import type { ProjectCommandDefinition } from "./definitions.ts";
import { createProjectCommandExecutorInternal } from "./execution/runner.ts";
import type { ResolvedProjectCommand } from "./resolution/types.ts";

export type ProjectCommandExecutionStatus =
  | "success"
  | "nonzero"
  | "timeout"
  | "spawn-failure"
  | "cancelled";

export interface ProjectCommandOutput {
  readonly text: string;
  readonly truncated: boolean;
  readonly totalBytes: number;
  readonly totalLines: number;
}

export interface ProjectCommandExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface ProjectCommandExecutionOutcome {
  readonly status: ProjectCommandExecutionStatus;
  readonly exit: ProjectCommandExit;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  /** Whether the process/in-process command was actually attempted. */
  readonly executed?: boolean;
  readonly stdout: ProjectCommandOutput;
  readonly stderr: ProjectCommandOutput;
  readonly structuredDetails?: unknown;
}

export interface ProjectCommandExecutorOptions {
  readonly spawn?: ProjectCommandSpawn;
  readonly platform?: NodeJS.Platform;
  readonly processTimeoutMs?: number;
  readonly killGraceMs?: number;
}

export type ProjectCommandSpawn = (
  executable: string,
  args: readonly string[],
  options: import("node:child_process").SpawnOptions,
) => import("node:child_process").ChildProcess;

type ProjectCommandExecutionInput = ResolvedProjectCommand | ProjectCommandDefinition;

export function createProjectCommandExecutor(
  options: ProjectCommandExecutorOptions = {},
): (
  resolved: ProjectCommandExecutionInput,
  cwd: string,
  signal?: AbortSignal,
) => Promise<ProjectCommandExecutionOutcome> {
  return createProjectCommandExecutorInternal(options);
}
