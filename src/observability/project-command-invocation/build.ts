import { boundedIdentifier, boundedNumber } from "../bounded.ts";
import {
  boundedCoercions,
  boundedLookup,
  boundedOutput,
  boundedPublication,
  boundedRecord,
  boundedState,
  redactProjectCommandParameters,
  validCacheDecision,
  validCategory,
  validReason,
  validStatus,
} from "./bound.ts";
import {
  PROJECT_COMMAND_INVOCATION_FORMAT_VERSION,
  type ProjectCommandInvocationRecord,
  type ProjectCommandInvocationRecordInput,
} from "./types.ts";

function boundedOptionalIdentifier(value: string | undefined): string | undefined {
  return value === undefined ? undefined : boundedIdentifier(value);
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
    ...(input.retryable === undefined ? {} : { retryable: input.retryable }),
    ...(boundedOptionalIdentifier(input.missingPhase) === undefined
      ? {}
      : { missingPhase: boundedOptionalIdentifier(input.missingPhase) }),
    ...(boundedOptionalIdentifier(input.missingScript) === undefined
      ? {}
      : { missingScript: boundedOptionalIdentifier(input.missingScript) }),
  };
  return boundedRecord(record);
}
