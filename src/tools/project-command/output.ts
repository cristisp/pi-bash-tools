import { displayPath } from "../path-display.ts";
import type { CommandIdentity } from "../policy/types.ts";
import type { ProjectCommandExecutionOutcome } from "./execution.ts";
import type { ProjectCommandResolutionError } from "./errors.ts";
import type { ResolvedProjectCommand } from "./resolution/types.ts";
import { ProjectCommandToolError } from "./schema.ts";

export interface ProjectCommandOutputDetails {
  readonly commandId: string;
  readonly projectPath: string;
  readonly fingerprint: string;
  readonly status: ProjectCommandExecutionOutcome["status"];
  readonly exit: ProjectCommandExecutionOutcome["exit"];
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly stdout: ProjectCommandExecutionOutcome["stdout"];
  readonly stderr: ProjectCommandExecutionOutcome["stderr"];
  readonly resolvedCommand: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly projectInfo?: unknown;
  readonly nodeVersion?: string;
  readonly manifestPresent?: boolean;
  readonly packageManager?: unknown;
  readonly scripts?: readonly string[];
  readonly applicableCommands?: readonly string[];
}

export type ProjectCommandRequestParameters = Readonly<Record<string, unknown>> & {
  readonly commandId: string;
};

export function displayCommand(resolved: ResolvedProjectCommand): string {
  return resolved.displayCommand ?? [resolved.executable, ...resolved.args].join(" ");
}

export function outputDetails(
  identity: CommandIdentity,
  projectPath: string,
  resolved: ResolvedProjectCommand,
  outcome: ProjectCommandExecutionOutcome,
): ProjectCommandOutputDetails {
  const projectInfo =
    typeof outcome.structuredDetails === "object" && outcome.structuredDetails !== null
      ? (outcome.structuredDetails as {
          readonly nodeVersion?: string;
          readonly manifestPresent?: boolean;
          readonly packageManager?: unknown;
          readonly scripts?: readonly string[];
          readonly applicableCommands?: readonly string[];
        })
      : undefined;
  return {
    commandId: identity.commandId,
    projectPath: displayPath(projectPath),
    fingerprint: identity.fingerprint,
    status: outcome.status,
    exit: outcome.exit,
    timedOut: outcome.timedOut,
    cancelled: outcome.cancelled,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    resolvedCommand: displayCommand(resolved),
    parameters: resolved.effectiveParameters ?? Object.freeze({}),
    ...(outcome.structuredDetails === undefined
      ? {}
      : {
          projectInfo: outcome.structuredDetails,
          ...(projectInfo?.nodeVersion === undefined
            ? {}
            : {
                nodeVersion: projectInfo.nodeVersion,
                manifestPresent: projectInfo.manifestPresent,
                packageManager: projectInfo.packageManager,
                scripts: projectInfo.scripts,
                applicableCommands: projectInfo.applicableCommands,
              }),
        }),
  };
}

function serializeDiagnostic(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

function outputDiagnostic(
  label: "stdout" | "stderr",
  output: ProjectCommandExecutionOutcome["stdout"],
): string | undefined {
  if (output.text.length === 0) {
    return undefined;
  }
  const truncation = output.truncated
    ? ` (truncated; ${output.totalBytes.toString(10)} bytes total)`
    : "";
  return `${label}: ${serializeDiagnostic(output.text)}${truncation}`;
}

function executionFailureReason(status: ProjectCommandExecutionOutcome["status"]): string {
  switch (status) {
    case "nonzero":
      return "the command exited with a nonzero status";
    case "timeout":
      return "the command timed out";
    case "spawn-failure":
      return "the command could not be started";
    case "cancelled":
      return "the command was cancelled";
    case "success":
      return "the command completed successfully";
  }
  return "the command failed";
}

function executionFailureMessage(details: ProjectCommandOutputDetails): string {
  const exit = [
    details.exit.code === null ? undefined : `code ${details.exit.code.toString(10)}`,
    details.exit.signal === null ? undefined : `signal ${details.exit.signal}`,
  ].filter((part): part is string => part !== undefined);
  const diagnostic =
    outputDiagnostic("stderr", details.stderr) ?? outputDiagnostic("stdout", details.stdout);
  return [
    "Project command failed",
    `status: ${details.status}`,
    `reason: ${executionFailureReason(details.status)}`,
    `commandId: ${details.commandId}`,
    `resolvedCommand: ${details.resolvedCommand}`,
    `parameters: ${serializeDiagnostic(details.parameters)}`,
    `exit: ${exit.length === 0 ? "unavailable" : exit.join(", ")}`,
    diagnostic,
  ]
    .filter((part): part is string => part !== undefined)
    .join("; ");
}

export function createExecutionFailure(
  identity: CommandIdentity,
  projectPath: string,
  resolved: ResolvedProjectCommand,
  outcome: ProjectCommandExecutionOutcome,
): ProjectCommandToolError {
  const details = outputDetails(identity, projectPath, resolved, outcome);
  return new ProjectCommandToolError(executionFailureMessage(details), details);
}

export function createResolutionFailure(
  params: ProjectCommandRequestParameters,
  error: ProjectCommandResolutionError,
): ProjectCommandToolError {
  const details = Object.freeze({
    ...error.details,
    status: "resolution-failure" as const,
    executed: false as const,
    commandId: params.commandId,
    requestedParameters: params,
    parameters: params,
    stage: error.stage,
    code: error.code,
    resolution: error.details,
    resolutionDetails: error.details,
  });
  const message = [
    "Project command resolution failed",
    "status: resolution-failure",
    `commandId: ${params.commandId}`,
    `requested parameters: ${serializeDiagnostic(params)}`,
    `stage: ${error.stage}`,
    `code: ${error.code}`,
    "execution: not attempted",
    `details: ${serializeDiagnostic(error.details)}`,
  ].join("; ");
  return new ProjectCommandToolError(message, details);
}
