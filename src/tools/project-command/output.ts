import {
  createToolErrorContract,
  suggestedActionForCategory,
  withToolErrorContract,
  type ResultCategory,
  type ToolErrorContract,
} from "../errors.ts";
import { displayPath } from "../path-display.ts";
import type { CommandIdentity } from "../policy/types.ts";
import type { ProjectCommandRelevantInputs } from "./relevant-inputs.ts";
import { definedObjectProperties } from "./defined-properties.ts";
import { projectCommandResultCategory } from "./categories.ts";
import type { ProjectCommandExecutionOutcome, ProjectCommandOutput } from "./execution.ts";
import type { ProjectCommandCacheDecision } from "./cache.ts";
import { boundProjectCommandText, projectCommandDiagnostic } from "./diagnostics.ts";
import type { ProjectCommandResolutionError } from "./errors.ts";
import { getProjectCommandDefinitions, type ProjectCommandDefinition } from "./definitions.ts";
import { projectCommandIdGuidance } from "./command-id-guidance.ts";
import type { ResolvedProjectCommand } from "./resolution/types.ts";
import { ProjectCommandToolError } from "./schema.ts";

export interface ProjectCommandScope {
  readonly cwdStrategy: ResolvedProjectCommand["definition"]["cwdStrategy"];
  readonly projectPath: string;
}

export interface ProjectCommandInvocationMetadata {
  readonly toolCallId: string;
  readonly durationMs: number;
  readonly executionDurationMs: number;
  readonly reused: boolean;
  readonly cacheDecision: ProjectCommandCacheDecision;
  readonly forced: boolean;
  readonly authFingerprint?: string;
  readonly policyId?: string;
  readonly reusePolicyId?: string;
  readonly resultFingerprintVersion?: number;
  readonly resultFingerprint?: string;
  readonly relevantInputs?: ProjectCommandRelevantInputs;
  readonly producerInvocationId?: string;
  readonly producerScope?: "session" | "flow";
}

export interface ProjectCommandOutputDetails {
  readonly commandId: string;
  readonly projectPath: string;
  readonly fingerprint: string;
  readonly authFingerprint: string;
  readonly resultFingerprint?: string;
  readonly resultFingerprintVersion?: number;
  readonly policyId?: string;
  readonly reusePolicyId?: string;
  readonly toolCallId: string;
  readonly relevantInputs?: ProjectCommandRelevantInputs;
  readonly producerInvocationId?: string;
  readonly producerScope?: "session" | "flow";
  readonly reused: boolean;
  readonly forced: boolean;
  readonly cacheDecision: ProjectCommandCacheDecision;
  readonly durationMs: number;
  readonly executionDurationMs: number;
  readonly scope: ProjectCommandScope;
  readonly status: ProjectCommandExecutionOutcome["status"];
  readonly category: ResultCategory;
  readonly executed: boolean;
  readonly error?: ToolErrorContract;
  readonly exit: ProjectCommandExecutionOutcome["exit"];
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly stdout: ProjectCommandExecutionOutcome["stdout"];
  readonly stderr: ProjectCommandExecutionOutcome["stderr"];
  readonly output: {
    readonly stdout: Pick<ProjectCommandOutput, "truncated" | "totalBytes" | "totalLines">;
    readonly stderr: Pick<ProjectCommandOutput, "truncated" | "totalBytes" | "totalLines">;
  };
  readonly diagnostic?: string;
  readonly suggestedAction?: string;
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

type NodeProjectInfoDetails = {
  readonly nodeVersion?: string;
  readonly manifestPresent?: boolean;
  readonly packageManager?: unknown;
  readonly scripts?: readonly string[];
  readonly applicableCommands?: readonly string[];
};

function outputMetadata(
  metadata: ProjectCommandInvocationMetadata,
): Readonly<Record<string, unknown>> {
  return definedObjectProperties([
    ["resultFingerprintVersion", metadata.resultFingerprintVersion],
    ["resultFingerprint", metadata.resultFingerprint],
    ["policyId", metadata.policyId],
    ["reusePolicyId", metadata.reusePolicyId],
    ["relevantInputs", metadata.relevantInputs],
    ["producerInvocationId", metadata.producerInvocationId],
    ["producerScope", metadata.producerScope],
  ]);
}

function outputDiagnostic(
  identity: CommandIdentity,
  category: ResultCategory,
  outcome: ProjectCommandExecutionOutcome,
): string | undefined {
  return category === "PASS"
    ? undefined
    : projectCommandDiagnostic(identity.commandId, outcome.stderr, outcome.stdout);
}

function outputCategoryDetails(category: ResultCategory): Readonly<Record<string, unknown>> {
  return definedObjectProperties([
    ["suggestedAction", category === "PASS" ? undefined : suggestedActionForCategory(category)],
  ]);
}

function outputProjectInfo(
  outcome: ProjectCommandExecutionOutcome,
): Readonly<Record<string, unknown>> {
  const structuredDetails = outcome.structuredDetails;
  if (structuredDetails === undefined) return {};
  if (typeof structuredDetails !== "object" || structuredDetails === null) {
    return { projectInfo: structuredDetails };
  }
  const projectInfo = structuredDetails as NodeProjectInfoDetails;
  if (projectInfo.nodeVersion === undefined) return { projectInfo: structuredDetails };
  return {
    projectInfo: structuredDetails,
    nodeVersion: projectInfo.nodeVersion,
    manifestPresent: projectInfo.manifestPresent,
    packageManager: projectInfo.packageManager,
    scripts: projectInfo.scripts,
    applicableCommands: projectInfo.applicableCommands,
  };
}

export function outputDetails(
  identity: CommandIdentity,
  projectPath: string,
  resolved: ResolvedProjectCommand,
  outcome: ProjectCommandExecutionOutcome,
  metadata: ProjectCommandInvocationMetadata,
): ProjectCommandOutputDetails {
  const category = projectCommandResultCategory(resolved.definition, outcome);
  const diagnostic = outputDiagnostic(identity, category, outcome);
  const scope = {
    cwdStrategy: resolved.definition.cwdStrategy,
    projectPath,
  } satisfies ProjectCommandScope;
  return {
    commandId: identity.commandId,
    projectPath: displayPath(projectPath),
    fingerprint: identity.fingerprint,
    authFingerprint: metadata.authFingerprint ?? identity.fingerprint,
    ...outputMetadata(metadata),
    toolCallId: metadata.toolCallId,
    reused: metadata.reused,
    forced: metadata.forced,
    cacheDecision: metadata.cacheDecision,
    durationMs: metadata.durationMs,
    executionDurationMs: metadata.executionDurationMs,
    scope,
    status: outcome.status,
    category,
    executed: outcome.executed ?? true,
    exit: outcome.exit,
    timedOut: outcome.timedOut,
    cancelled: outcome.cancelled,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    output: {
      stdout: {
        truncated: outcome.stdout.truncated,
        totalBytes: outcome.stdout.totalBytes,
        totalLines: outcome.stdout.totalLines,
      },
      stderr: {
        truncated: outcome.stderr.truncated,
        totalBytes: outcome.stderr.totalBytes,
        totalLines: outcome.stderr.totalLines,
      },
    },
    ...definedObjectProperties([["diagnostic", diagnostic]]),
    ...outputCategoryDetails(category),
    resolvedCommand: displayCommand(resolved),
    parameters: resolved.effectiveParameters ?? Object.freeze({}),
    ...outputProjectInfo(outcome),
  };
}

function serializeDiagnostic(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

export { suggestedActionForCategory } from "../errors.ts";

function executionFailureContract(details: ProjectCommandOutputDetails): ToolErrorContract {
  const category = details.category;
  const contractCategory = category === "PASS" ? "IMPLEMENTATION_FAILURE" : category;
  const suggestedAction = suggestedActionForCategory(contractCategory);
  const code =
    category === "TIMEOUT"
      ? "process-timeout"
      : category === "SPAWN_FAILURE"
        ? "spawn-failure"
        : category === "CANCELLED"
          ? "cancelled"
          : "command-nonzero";
  const explanation =
    category === "TIMEOUT"
      ? "The project command exceeded its process time limit."
      : category === "SPAWN_FAILURE"
        ? "The project command could not be started."
        : category === "CANCELLED"
          ? "The project command was cancelled."
          : "The project command exited with a nonzero status.";
  return createToolErrorContract({
    code,
    category: contractCategory,
    explanation,
    ...(suggestedAction === undefined ? {} : { suggestedAction }),
    retryable: true,
    executed: details.executed,
  });
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
    details.exit.signal === null
      ? undefined
      : `signal ${boundProjectCommandText(details.exit.signal)}`,
  ].filter((part): part is string => part !== undefined);
  const diagnostic =
    details.diagnostic === undefined
      ? undefined
      : `diagnostic: ${boundProjectCommandText(serializeDiagnostic(details.diagnostic))}`;
  return boundProjectCommandText(
    [
      "Project command failed",
      `status: ${boundProjectCommandText(details.status)}`,
      `reason: ${boundProjectCommandText(executionFailureReason(details.status))}`,
      `commandId: ${boundProjectCommandText(details.commandId)}`,
      `resolvedCommand: ${boundProjectCommandText(details.resolvedCommand)}`,
      `parameters: ${boundProjectCommandText(serializeDiagnostic(details.parameters))}`,
      `exit: ${exit.length === 0 ? "unavailable" : exit.join(", ")}`,
      diagnostic,
    ]
      .filter((part): part is string => part !== undefined)
      .join("; "),
  );
}

export function createExecutionFailure(
  identity: CommandIdentity,
  projectPath: string,
  resolved: ResolvedProjectCommand,
  outcome: ProjectCommandExecutionOutcome,
  metadata: ProjectCommandInvocationMetadata,
): ProjectCommandToolError {
  const details = outputDetails(identity, projectPath, resolved, outcome, metadata);
  const contract = executionFailureContract(details);
  return new ProjectCommandToolError(
    executionFailureMessage(details),
    withToolErrorContract(details, contract),
    contract,
  );
}

export function createResolutionFailure(
  params: ProjectCommandRequestParameters,
  error: ProjectCommandResolutionError,
  definitions: readonly ProjectCommandDefinition[] = getProjectCommandDefinitions(),
): ProjectCommandToolError {
  const contract = createToolErrorContract({
    code: "resolution-failure",
    category: "RESOLUTION_FAILURE",
    explanation: "The project command could not be resolved for execution.",
    suggestedAction: suggestedActionForCategory("RESOLUTION_FAILURE"),
    retryable: true,
    executed: false,
  });
  const guidance = projectCommandIdGuidance(params.commandId, definitions);
  const details = withToolErrorContract(
    {
      ...error.details,
      ...guidance,
      status: "resolution-failure" as const,
      executed: false as const,
      commandId: params.commandId,
      requestedParameters: params,
      parameters: params,
      stage: error.stage,
      code: error.code,
      resolution: error.details,
      resolutionDetails: error.details,
    },
    contract,
  );
  const message = [
    "Project command resolution failed",
    "status: resolution-failure",
    `commandId: ${params.commandId}`,
    `requested parameters: ${serializeDiagnostic(params)}`,
    `stage: ${error.stage}`,
    `code: ${error.code}`,
    "execution: not attempted",
    `details: ${serializeDiagnostic(error.details)}`,
    `action: ${guidance.remediation}`,
  ].join("; ");
  return new ProjectCommandToolError(message, details, contract);
}
