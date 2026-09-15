import type { SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";

import { boundedIdentifier } from "../bounded.ts";
import { appendInvocationStreamRecord } from "../invocation-stream.ts";
import { buildProjectCommandInvocationRecord } from "./build.ts";
import {
  addSummaryRecord,
  createSummaryAccumulator,
  summaryFromAccumulator,
  type ProjectCommandInvocationSummaryAccumulator,
} from "./summarize.ts";
import {
  PROJECT_COMMAND_INVOCATION_ENTRY_TYPE,
  PROJECT_COMMAND_SUMMARY_ENTRY_TYPE,
  type ProjectCommandInvocationAPI,
  type ProjectCommandInvocationLifecycleContext,
  type ProjectCommandInvocationRecordInput,
  type ProjectCommandInvocationRecorder,
  type ProjectCommandInvocationSessionRecorder,
} from "./types.ts";

function contextSessionId(context: ProjectCommandInvocationLifecycleContext): string | undefined {
  try {
    const sessionId = context.sessionManager.getSessionId();
    return typeof sessionId === "string" && sessionId.length > 0
      ? boundedIdentifier(sessionId)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keep the existing per-invocation entries while aggregating only the active session in memory.
 * The accumulator is intentionally discarded on shutdown and is never restored from a session.
 */
export function createProjectCommandInvocationSessionRecorder(
  api: ProjectCommandInvocationAPI,
): ProjectCommandInvocationSessionRecorder {
  const invocationRecorder = createProjectCommandInvocationRecorder(api);
  let activeSessionId: string | undefined;
  let accumulator: ProjectCommandInvocationSummaryAccumulator | undefined;
  let shutdownFlushed = false;

  const onSessionStart = (
    _event: Pick<SessionStartEvent, "reason">,
    context: ProjectCommandInvocationLifecycleContext,
  ): void => {
    activeSessionId = contextSessionId(context);
    accumulator =
      activeSessionId === undefined ? undefined : createSummaryAccumulator(activeSessionId);
    shutdownFlushed = false;
  };

  const onSessionShutdown = (
    _event: Pick<SessionShutdownEvent, "reason">,
    context: ProjectCommandInvocationLifecycleContext,
  ): void => {
    if (shutdownFlushed) return;
    shutdownFlushed = true;
    const sessionId = activeSessionId;
    const currentSessionId = contextSessionId(context);
    if (sessionId !== undefined && sessionId === currentSessionId && accumulator !== undefined) {
      try {
        api.appendEntry(PROJECT_COMMAND_SUMMARY_ENTRY_TYPE, summaryFromAccumulator(accumulator));
      } catch {
        // Summary persistence must never affect session shutdown or command results.
      }
    }
    activeSessionId = undefined;
    accumulator = undefined;
  };

  const record: ProjectCommandInvocationRecorder = (invocation) => {
    invocationRecorder(invocation);
    if (activeSessionId === undefined || invocation.sessionId !== activeSessionId) return;
    if (accumulator === undefined) accumulator = createSummaryAccumulator(activeSessionId);
    try {
      addSummaryRecord(accumulator, invocation);
    } catch {
      // Aggregation is observational and must not affect command execution.
    }
  };

  return Object.freeze({ invocationRecorder: record, onSessionStart, onSessionShutdown });
}

/** Create a best-effort recorder backed by Pi's session custom-entry API and JSONL stream. */
export function createProjectCommandInvocationRecorder(
  api: ProjectCommandInvocationAPI,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ProjectCommandInvocationRecorder {
  return (record) => {
    try {
      api.appendEntry(PROJECT_COMMAND_INVOCATION_ENTRY_TYPE, record);
    } catch {
      // Observability must never change a command result or error.
    }
    appendInvocationStreamRecord(record, environment);
  };
}

/** Invoke an injected recorder without allowing observability failures to escape. */
export function recordProjectCommandInvocation(
  recorder: ProjectCommandInvocationRecorder | undefined,
  input: ProjectCommandInvocationRecordInput,
): void {
  if (recorder === undefined) return;
  try {
    recorder(buildProjectCommandInvocationRecord(input));
  } catch {
    // A test or alternate recorder is also best effort by contract.
  }
}
