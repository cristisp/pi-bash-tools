import type { ProjectCommandCacheDecision } from "../../tools/project-command/cache.ts";
import { boundedIdentifier, boundedNumber } from "../bounded.ts";
import {
  boundedCoercions,
  boundedLookup,
  boundedMeasurements,
  boundedOutput,
  boundedPublication,
  boundedRecord,
  boundedState,
  createMeasurementState,
  measurementsFromStates,
  redactProjectCommandParameters,
  validCacheDecision,
  validCategory,
  validReason,
  validStatus,
} from "./bound.ts";
import {
  PROJECT_COMMAND_INVOCATION_FORMAT_VERSION,
  type ProjectCommandInvocationMeasurements,
  type ProjectCommandInvocationOutputMetadata,
  type ProjectCommandInvocationRecord,
  type ProjectCommandInvocationRecordInput,
} from "./types.ts";

function boundedOptionalIdentifier(value: string | undefined): string | undefined {
  return value === undefined ? undefined : boundedIdentifier(value);
}

export function createProjectCommandInvocationMeasurements(
  cacheDecision: ProjectCommandCacheDecision,
  reused: boolean,
  output: ProjectCommandInvocationOutputMetadata | undefined,
): ProjectCommandInvocationMeasurements {
  const after = createMeasurementState();
  after.cacheReuse = reused ? 1 : 0;
  after.cacheInvalidation = cacheDecision === "invalidated" ? 1 : 0;
  after.truncation =
    (output?.stdout.truncated === true ? 1 : 0) + (output?.stderr.truncated === true ? 1 : 0);
  after.repeatedRequests = cacheDecision === "hit" && reused ? 1 : 0;
  return measurementsFromStates(createMeasurementState(), after);
}

function defaultMeasurements(
  input: ProjectCommandInvocationRecordInput,
): ProjectCommandInvocationMeasurements {
  return createProjectCommandInvocationMeasurements(
    input.cacheDecision,
    input.reused,
    input.output,
  );
}

/** Build a compact, persistence-safe invocation record without command output or paths. */
export function buildProjectCommandInvocationRecord(
  input: ProjectCommandInvocationRecordInput,
): ProjectCommandInvocationRecord {
  const parameters =
    input.redactedParameters ??
    (input.parameters === undefined ? undefined : redactProjectCommandParameters(input.parameters));
  const record: ProjectCommandInvocationRecord = {
    invocationFormatVersion: PROJECT_COMMAND_INVOCATION_FORMAT_VERSION,
    sessionId: boundedIdentifier(input.sessionId),
    toolCallId: boundedIdentifier(input.toolCallId),
    schemaHash: boundedIdentifier(input.schemaHash),
    ...(input.commandId === undefined ? {} : { commandId: boundedIdentifier(input.commandId) }),
    ...(parameters === undefined ? {} : { parameters }),
    resultCategory: validCategory(input.resultCategory),
    ...(validStatus(input.status) === undefined ? {} : { status: validStatus(input.status) }),
    executed: input.executed,
    reason: validReason(input.reason),
    cacheDecision: validCacheDecision(input.cacheDecision),
    forced: input.forced,
    reused: input.reused,
    durationMs: boundedNumber(input.durationMs),
    executionDurationMs: boundedNumber(input.executionDurationMs),
    ...(input.preparationDurationMs === undefined
      ? {}
      : { preparationDurationMs: boundedNumber(input.preparationDurationMs) }),
    ...(input.authorizationDurationMs === undefined
      ? {}
      : { authorizationDurationMs: boundedNumber(input.authorizationDurationMs) }),
    ...(input.queueDurationMs === undefined
      ? {}
      : { queueDurationMs: boundedNumber(input.queueDurationMs) }),
    output: boundedOutput(input.output),
    measurements: boundedMeasurements(input.measurements ?? defaultMeasurements(input)),
    ...(input.producerScope === undefined ? {} : { producerScope: input.producerScope }),
    ...(boundedOptionalIdentifier(input.flowId) === undefined
      ? {}
      : { flowId: boundedOptionalIdentifier(input.flowId) }),
    ...(boundedOptionalIdentifier(input.delegationId) === undefined
      ? {}
      : { delegationId: boundedOptionalIdentifier(input.delegationId) }),
    ...(boundedOptionalIdentifier(input.role) === undefined
      ? {}
      : { role: boundedOptionalIdentifier(input.role) }),
    ...(boundedOptionalIdentifier(input.ref) === undefined
      ? {}
      : { ref: boundedOptionalIdentifier(input.ref) }),
    ...(boundedState(input.repositoryState) === undefined
      ? {}
      : { repositoryState: boundedState(input.repositoryState) }),
    ...(input.verdict === undefined ? {} : { verdict: input.verdict }),
    ...(input.mutating === undefined ? {} : { mutating: input.mutating }),
    ...(boundedPublication(input.publication) === undefined
      ? {}
      : { publication: boundedPublication(input.publication) }),
    ...(boundedLookup(input.lookup) === undefined ? {} : { lookup: boundedLookup(input.lookup) }),
    ...(boundedCoercions(input.coercions) === undefined
      ? {}
      : { coercions: boundedCoercions(input.coercions) }),
    ...(input.concurrentExecutions === undefined
      ? {}
      : { concurrentExecutions: boundedNumber(input.concurrentExecutions) }),
    ...(input.stateDrift === undefined ? {} : { stateDrift: input.stateDrift }),
    ...(input.sharedExecution === undefined ? {} : { sharedExecution: input.sharedExecution }),
    ...(input.aggregate === undefined ? {} : { aggregate: input.aggregate }),
  };
  return boundedRecord(record);
}
