import { spawn, type ChildProcess } from "node:child_process";
import { resolveFixedProjectCommand } from "../resolution.ts";
import type { ResolvedProjectCommand } from "../resolution/types.ts";
import { outputCaptures, emptyOutcome, outcomeWithOutput, Capture } from "./capture.ts";
import { DEFAULT_KILL_GRACE_MS, environmentForProfile } from "./environment.ts";
import { monitorChild, setupChildMonitor, type ChildRunState } from "./monitor.ts";
import type {
  ProjectCommandExecutionOutcome,
  ProjectCommandExecutorOptions,
  ProjectCommandSpawn,
} from "../execution.ts";
import type { ProjectCommandExecutionInput } from "./types.ts";

function spawnProjectCommand(
  executable: string,
  args: readonly string[],
  options: Parameters<ProjectCommandSpawn>[2],
): ChildProcess {
  return spawn(executable, [...args], options);
}

function resolvedCommand(input: ProjectCommandExecutionInput): ResolvedProjectCommand {
  return "definition" in input ? input : resolveFixedProjectCommand(input);
}

function outcomeFromState(
  state: ChildRunState,
  stdout: Capture,
  stderr: Capture,
): ProjectCommandExecutionOutcome {
  const base = {
    exit: state.exit,
    timedOut: state.timedOut,
    cancelled: state.cancelled,
    stdout: stdout.output(),
    stderr: stderr.output(),
  };
  if (state.cancelled) {
    return { status: "cancelled", ...base };
  }
  if (state.timedOut) {
    return { status: "timeout", ...base };
  }
  if (state.spawnFailure) {
    return { status: "spawn-failure", ...base };
  }
  return { status: state.exit.code === 0 ? "success" : "nonzero", ...base };
}

async function executeProjectCommand(
  input: ProjectCommandExecutionInput,
  cwd: string,
  signal: AbortSignal | undefined,
  spawnCommand: ProjectCommandSpawn,
  platform: NodeJS.Platform,
  processTimeoutMs: number,
  graceMs: number,
): Promise<ProjectCommandExecutionOutcome> {
  const resolved = resolvedCommand(input);
  if (signal?.aborted) {
    return emptyOutcome("cancelled");
  }
  if (resolved.definition.executionKind === "in-process") {
    if (signal?.aborted) {
      return emptyOutcome("cancelled");
    }
    return {
      ...emptyOutcome("success"),
      structuredDetails: resolved.structuredDetails,
    };
  }
  const { stdout, stderr } = outputCaptures(resolved.definition);
  let child: ChildProcess;
  try {
    child = spawnCommand(resolved.executable, resolved.args, {
      cwd,
      shell: false,
      detached: platform === "darwin",
      env: environmentForProfile(resolved.definition.sanitizedEnvironmentProfile),
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
  } catch {
    return outcomeWithOutput("spawn-failure", stdout, stderr);
  }
  try {
    const monitor = setupChildMonitor(child, stdout, stderr, platform, graceMs);
    const state = await monitorChild(monitor, signal, processTimeoutMs);
    return outcomeFromState(state, stdout, stderr);
  } catch {
    return outcomeWithOutput("spawn-failure", stdout, stderr);
  }
}

export function createProjectCommandExecutorInternal(
  options: ProjectCommandExecutorOptions = {},
): (
  resolved: ProjectCommandExecutionInput,
  cwd: string,
  signal?: AbortSignal,
) => Promise<ProjectCommandExecutionOutcome> {
  const spawnCommand = options.spawn ?? spawnProjectCommand;
  const platform = options.platform ?? process.platform;
  const graceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  return (input, cwd, signal) => {
    const resolved = resolvedCommand(input);
    return executeProjectCommand(
      resolved,
      cwd,
      signal,
      spawnCommand,
      platform,
      options.processTimeoutMs ?? resolved.definition.processTimeoutMs,
      graceMs,
    );
  };
}
