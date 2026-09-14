import { realpath } from "node:fs/promises";

import { afterEach, expect, it, vi } from "vitest";

import type { ProjectCommandInvocationRecord } from "../../src/observability/project-command-invocation.ts";
import { displayPath } from "../../src/tools/path-display.ts";
import { getProjectCommandDefinition } from "../../src/tools/project-command/definitions.ts";
import { PROJECT_COMMAND_DIAGNOSTIC_MAX_CHARS } from "../../src/tools/project-command/diagnostics.ts";
import type {
  ProjectCommandEvidenceRecord,
  ProjectCommandEvidenceStore,
} from "../../src/tools/project-command/evidence.ts";
import type { ProjectCommandExecutionOutcome } from "../../src/tools/project-command/execution.ts";
import type { ProjectCommandRepositoryState } from "../../src/tools/project-command/repository-state.ts";
import { resolveFixedProjectCommand } from "../../src/tools/project-command/resolution.ts";
import type { ResolvedProjectCommand } from "../../src/tools/project-command/resolution/types.ts";
import { projectCommandSingleFlightCountsForTesting } from "../../src/tools/project-command/runner.ts";
import { ProjectCommandToolError } from "../../src/tools/project-command/schema.ts";
import { createProjectCommandToolForTesting } from "../../src/tools/project-command/tool.ts";
import {
  authorize,
  executeInjectedOutcome,
  expectInvocationMetadata,
} from "./tool-execution-helpers.ts";
import { cleanupProjectCommandFixtures, context, fixture } from "./tool-test-fixtures.ts";

afterEach(cleanupProjectCommandFixtures);

function hasEscapeOrC1Control(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === 0x1b || (codePoint !== undefined && codePoint >= 0x80 && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}

it("adds invocation metadata to an invalid request without resolved scope or output", async () => {
  const fixtureData = await fixture();
  const records: ProjectCommandInvocationRecord[] = [];
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    invocationRecorder: (record) => records.push(record),
  });
  const error = await tool
    .execute(
      "invalid-request",
      { commandId: "node_lint", variant: "-unsafe" },
      undefined,
      undefined,
      context(fixtureData.directory, {
        sessionManager: { getSessionId: () => "invalid-session" },
      }),
    )
    .catch((rejection: unknown) => rejection);
  expect(records).toMatchObject([
    {
      sessionId: "invalid-session",
      toolCallId: "invalid-request",
      resultCategory: "INVALID_REQUEST",
      executed: false,
      cacheDecision: "ineligible",
      reason: "invalid-request",
      output: {
        stdout: { totalBytes: 0, truncated: false },
        stderr: { totalBytes: 0, truncated: false },
      },
    },
  ]);
  expect(error).toBeInstanceOf(ProjectCommandToolError);
  if (!(error instanceof ProjectCommandToolError)) {
    throw new Error("expected a ProjectCommandToolError");
  }
  expect(error.details).toMatchObject({
    category: "INVALID_REQUEST",
    executed: false,
    toolCallId: "invalid-request",
    reused: false,
    durationMs: expect.any(Number),
    executionDurationMs: 0,
    suggestedAction: "Correct the invalid request field and retry the command.",
    error: {
      code: "invalid-request",
      category: "INVALID_REQUEST",
      suggestedAction: "Correct the invalid request field and retry the command.",
      invalidField: "variant",
      executed: false,
    },
  });
  expect(error.details).not.toHaveProperty("scope");
  expect(error.details).not.toHaveProperty("output");
  expectInvocationMetadata(error.details, "invalid-request");
});

it("shares one non-mutating evidence execution across overlapping identical requests", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("workspace_path");
  if (definition === undefined) throw new Error("missing workspace_path definition");
  const resolved = resolveFixedProjectCommand(definition);
  await authorize(fixtureData, definition, resolved);
  let resolveExecutorStarted: (() => void) | undefined;
  const executorStarted = new Promise<void>((resolve) => {
    resolveExecutorStarted = resolve;
  });
  let resolveSecondResolver: (() => void) | undefined;
  const secondResolverDone = new Promise<void>((resolve) => {
    resolveSecondResolver = resolve;
  });
  let resolverCalls = 0;
  const outcome: ProjectCommandExecutionOutcome = {
    status: "success",
    exit: { code: 0, signal: null },
    timedOut: false,
    cancelled: false,
    stdout: { text: "shared", truncated: false, totalBytes: 6, totalLines: 1 },
    stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
  };
  let executionReleased = false;
  const pendingExecutions: Array<(value: ProjectCommandExecutionOutcome) => void> = [];
  const release = () => {
    executionReleased = true;
    for (const resolve of pendingExecutions.splice(0)) resolve(outcome);
  };
  const executor = vi.fn(
    () =>
      new Promise<ProjectCommandExecutionOutcome>((resolve) => {
        resolveExecutorStarted?.();
        if (executionReleased) resolve(outcome);
        else pendingExecutions.push(resolve);
      }),
  );
  const records: ProjectCommandInvocationRecord[] = [];
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    executor,
    invocationRecorder: (record) => records.push(record),
    resolver: async (commandDefinition) => {
      resolverCalls += 1;
      if (resolverCalls === 2) resolveSecondResolver?.();
      return resolveFixedProjectCommand(commandDefinition);
    },
  });
  const first = tool.execute(
    "single-flight-1",
    { commandId: "workspace_path" },
    undefined,
    undefined,
    context(fixtureData.directory, {
      sessionManager: { getSessionId: () => "single-flight-session" },
    }),
  );
  await executorStarted;
  const second = tool.execute(
    "single-flight-2",
    { commandId: "workspace_path" },
    undefined,
    undefined,
    context(fixtureData.directory, {
      sessionManager: { getSessionId: () => "single-flight-session" },
    }),
  );
  await secondResolverDone;
  await vi.waitFor(() => {
    const counts = [...projectCommandSingleFlightCountsForTesting().values()];
    expect(counts).toContain(2);
  });
  expect(executor).toHaveBeenCalledTimes(1);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  expect(firstResult.details).toMatchObject({
    executed: true,
    sharedExecution: false,
    concurrentExecutions: 1,
  });
  expect(secondResult.details).toMatchObject({
    executed: false,
    reused: false,
    sharedExecution: true,
    concurrentExecutions: 2,
  });
  expect(secondResult.details.ref).toBe(firstResult.details.ref);
  const leader = records.find((record) => record.toolCallId === "single-flight-1");
  const follower = records.find((record) => record.toolCallId === "single-flight-2");
  expect(leader?.sharedExecution).toBe(false);
  expect(leader?.preparationDurationMs).toBeGreaterThanOrEqual(0);
  expect(leader?.authorizationDurationMs).toBeGreaterThanOrEqual(0);
  expect(leader === undefined ? true : "queueDurationMs" in leader).toBe(false);
  expect(follower?.sharedExecution).toBe(true);
  expect(follower?.executionDurationMs).toBe(0);
  expect(follower?.preparationDurationMs).toBeGreaterThanOrEqual(0);
  expect(follower?.authorizationDurationMs).toBeGreaterThanOrEqual(0);
  expect(follower?.queueDurationMs).toBeGreaterThanOrEqual(0);
  for (const record of records) {
    const phased =
      (record.preparationDurationMs ?? 0) +
      (record.authorizationDurationMs ?? 0) +
      (record.queueDurationMs ?? 0) +
      record.executionDurationMs;
    expect(record.durationMs).toBeGreaterThanOrEqual(phased);
  }
}, 15_000);

it("looks up stored evidence and rejects missing references", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("workspace_path");
  if (definition === undefined) throw new Error("missing workspace_path definition");
  const resolved = resolveFixedProjectCommand(definition);
  await authorize(fixtureData, definition, resolved);
  let storedRecord: ProjectCommandEvidenceRecord | undefined;
  const evidence: ProjectCommandEvidenceStore = {
    getByRef: (ref) => (storedRecord?.ref === ref ? storedRecord : undefined),
    set: (record) => {
      storedRecord = record;
      return true;
    },
    publish: () => false,
    clear: () => {
      storedRecord = undefined;
    },
  };
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    evidence,
    executor: async () => ({
      status: "success" as const,
      exit: { code: 0, signal: null },
      timedOut: false,
      cancelled: false,
      stdout: { text: "workspace", truncated: false, totalBytes: 9, totalLines: 1 },
      stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
    }),
  });
  const executed = await tool.execute(
    "lookup-producer",
    { commandId: "workspace_path" },
    undefined,
    undefined,
    context(fixtureData.directory),
  );
  const ref = executed.details.ref;
  if (typeof ref !== "string") throw new Error("expected an evidence reference");

  const lookedUp = await tool.execute(
    "lookup-consumer",
    { ref },
    undefined,
    undefined,
    context(fixtureData.directory),
  );
  expect(lookedUp.details).toMatchObject({
    commandId: "workspace_path",
    ref,
    executed: true,
    reused: false,
  });

  const missing = await tool
    .execute(
      "lookup-missing",
      { ref: "pc_missing" },
      undefined,
      undefined,
      context(fixtureData.directory),
    )
    .catch((error: unknown) => error);
  expect(missing).toBeInstanceOf(ProjectCommandToolError);
  expect(missing).toMatchObject({
    contract: { code: "project-command-error", category: "IMPLEMENTATION_FAILURE" },
  });
  expect(missing).toHaveProperty("message", expect.stringContaining("pc_missing"));
});

function lookupSessionContext(directory: string) {
  return context(directory, {
    sessionManager: { getSessionId: () => "lookup-session" },
  });
}

it("records success and not-found evidence lookup telemetry outcomes", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("workspace_path");
  if (definition === undefined) throw new Error("missing workspace_path definition");
  const resolved = resolveFixedProjectCommand(definition);
  await authorize(fixtureData, definition, resolved);
  let storedRecord: ProjectCommandEvidenceRecord | undefined;
  const lookupOutcome = vi.fn(() => "missing" as const);
  const evidence: ProjectCommandEvidenceStore = {
    getByRef: (ref) => (storedRecord?.ref === ref ? storedRecord : undefined),
    lookupOutcome,
    set: (record) => {
      storedRecord = record;
      return true;
    },
    publish: () => false,
    clear: () => {
      storedRecord = undefined;
    },
  };
  const records: ProjectCommandInvocationRecord[] = [];
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    evidence,
    invocationRecorder: (record) => records.push(record),
    executor: async () => ({
      status: "success" as const,
      exit: { code: 0, signal: null },
      timedOut: false,
      cancelled: false,
      stdout: { text: "workspace", truncated: false, totalBytes: 9, totalLines: 1 },
      stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
    }),
  });
  const executed = await tool.execute(
    "lookup-producer",
    { commandId: "workspace_path" },
    undefined,
    undefined,
    lookupSessionContext(fixtureData.directory),
  );
  const ref = executed.details.ref;
  if (typeof ref !== "string") throw new Error("expected an evidence reference");

  await tool.execute(
    "lookup-consumer",
    { ref },
    undefined,
    undefined,
    lookupSessionContext(fixtureData.directory),
  );
  expect(records.find((record) => record.toolCallId === "lookup-consumer")?.lookup).toEqual({
    attempted: true,
    success: true,
    outcome: "success",
  });
  const producer = records.find((record) => record.toolCallId === "lookup-producer");
  expect(producer?.preparationDurationMs).toBeGreaterThanOrEqual(0);
  expect(producer?.authorizationDurationMs).toBeGreaterThanOrEqual(0);
  expect(producer === undefined ? true : "queueDurationMs" in producer).toBe(false);
  const consumerLookup = records.find((record) => record.toolCallId === "lookup-consumer");
  expect(consumerLookup === undefined ? true : "preparationDurationMs" in consumerLookup).toBe(
    false,
  );
  expect(consumerLookup === undefined ? true : "authorizationDurationMs" in consumerLookup).toBe(
    false,
  );
  expect(consumerLookup === undefined ? true : "queueDurationMs" in consumerLookup).toBe(false);

  const missing = await tool
    .execute(
      "lookup-missing",
      { ref: "pc_missing1" },
      undefined,
      undefined,
      lookupSessionContext(fixtureData.directory),
    )
    .catch((error: unknown) => error);
  expect(missing).toBeInstanceOf(ProjectCommandToolError);
  expect(missing).toHaveProperty(
    "message",
    "Project command evidence ref pc_missing1 not found in the process-local root-session store; evidence refs are non-replayable and process-scoped.",
  );
  expect(records.find((record) => record.toolCallId === "lookup-missing")?.lookup).toEqual({
    attempted: true,
    success: false,
    failure: "not-found",
    outcome: "not-found",
  });
  const missingLookup = records.find((record) => record.toolCallId === "lookup-missing");
  expect(missingLookup === undefined ? true : "preparationDurationMs" in missingLookup).toBe(false);
  expect(missingLookup === undefined ? true : "authorizationDurationMs" in missingLookup).toBe(
    false,
  );
  expect(missingLookup === undefined ? true : "queueDurationMs" in missingLookup).toBe(false);
  expect(lookupOutcome).toHaveBeenCalledWith("pc_missing1", undefined);
});

it("records the corrupt outcome for detectable in-process corruption", async () => {
  const fixtureData = await fixture();
  const evidence: ProjectCommandEvidenceStore = {
    getByRef: () => undefined,
    lookupOutcome: () => "corrupt",
    set: () => true,
    publish: () => false,
    clear: () => undefined,
  };
  const records: ProjectCommandInvocationRecord[] = [];
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    evidence,
    invocationRecorder: (record) => records.push(record),
  });
  const corrupt = await tool
    .execute(
      "lookup-corrupt",
      { ref: "pc_corrupt0" },
      undefined,
      undefined,
      lookupSessionContext(fixtureData.directory),
    )
    .catch((error: unknown) => error);
  expect(corrupt).toBeInstanceOf(ProjectCommandToolError);
  expect(corrupt).toHaveProperty(
    "message",
    "Project command evidence ref pc_corrupt0 not found in the process-local root-session store; evidence refs are non-replayable and process-scoped.",
  );
  expect(records.find((record) => record.toolCallId === "lookup-corrupt")?.lookup).toEqual({
    attempted: true,
    success: false,
    failure: "not-found",
    outcome: "corrupt",
  });
});

it("classifies wrong-flow evidence lookups as unauthorized-flow without querying the store", async () => {
  const fixtureData = await fixture();
  const getByRef = vi.fn(() => undefined);
  const lookupOutcome = vi.fn(() => "missing" as const);
  const evidence: ProjectCommandEvidenceStore = {
    getByRef,
    lookupOutcome,
    set: () => true,
    publish: () => false,
    clear: () => undefined,
  };
  const records: ProjectCommandInvocationRecord[] = [];
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    evidence,
    invocationRecorder: (record) => records.push(record),
  });
  const wrongFlow = await tool
    .execute(
      "lookup-wrong-flow",
      { ref: "pc_flowrefs", flowId: "flow-a" },
      undefined,
      undefined,
      lookupSessionContext(fixtureData.directory),
    )
    .catch((error: unknown) => error);
  expect(wrongFlow).toBeInstanceOf(ProjectCommandToolError);
  expect(wrongFlow).toHaveProperty(
    "message",
    "Project command evidence ref pc_flowrefs not found in flow flow-a; evidence refs are non-replayable and process-scoped.",
  );
  expect(getByRef).not.toHaveBeenCalled();
  expect(lookupOutcome).not.toHaveBeenCalled();
  expect(records.find((record) => record.toolCallId === "lookup-wrong-flow")?.lookup).toEqual({
    attempted: true,
    success: false,
    failure: "not-found",
    outcome: "unauthorized-flow",
  });
});

it("reports repository state drift after an execution moves the tree", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("workspace_path");
  if (definition === undefined) throw new Error("missing workspace_path definition");
  const resolved = resolveFixedProjectCommand(definition);
  await authorize(fixtureData, definition, resolved);
  const before: ProjectCommandRepositoryState = {
    repositoryIdentity: "/repo",
    head: "head-a",
    dirtyFilesDigest: "dirty-a",
  };
  const after: ProjectCommandRepositoryState = {
    ...before,
    dirtyFilesDigest: "dirty-b",
  };
  let reads = 0;
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    repositoryStateReader: async () => (reads++ === 0 ? before : after),
    executor: async () => ({
      status: "success" as const,
      exit: { code: 0, signal: null },
      timedOut: false,
      cancelled: false,
      stdout: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
      stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
    }),
  });
  const response = await tool.execute(
    "state-drift",
    { commandId: "workspace_path" },
    undefined,
    undefined,
    context(fixtureData.directory),
  );
  expect(response.details).toMatchObject({
    repositoryStateStatus: "mismatch",
    stateDrift: true,
    recordedRepositoryState: before,
    currentRepositoryState: after,
  });
});

it("reports invocation identity, normalized scope, bounded output metadata, and durations", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("workspace_path");
  if (definition === undefined) throw new Error("missing workspace_path definition");
  const resolved = resolveFixedProjectCommand(definition);
  const projectPath = await authorize(fixtureData, definition, resolved);
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    executor: async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return {
        status: "success" as const,
        exit: { code: 0, signal: null },
        timedOut: false,
        cancelled: false,
        stdout: { text: "raw stdout", truncated: false, totalBytes: 10, totalLines: 1 },
        stderr: { text: "raw stderr", truncated: true, totalBytes: 20, totalLines: 2 },
      };
    },
  });
  const response = await tool.execute(
    "metadata",
    { commandId: "workspace_path" },
    undefined,
    undefined,
    context(fixtureData.directory),
  );
  expect(response.details).toMatchObject({
    commandId: "workspace_path",
    projectPath: displayPath(projectPath),
    toolCallId: "metadata",
    reused: false,
    scope: { cwdStrategy: "canonical-project", projectPath },
    stdout: { text: "raw stdout", truncated: false, totalBytes: 10, totalLines: 1 },
    stderr: { text: "raw stderr", truncated: true, totalBytes: 20, totalLines: 2 },
    output: {
      stdout: { truncated: false, totalBytes: 10, totalLines: 1 },
      stderr: { truncated: true, totalBytes: 20, totalLines: 2 },
    },
  });
  expectInvocationMetadata(response.details, "metadata");
  if (response.details.executionDurationMs <= 0) {
    throw new Error("expected executor duration");
  }
});

function expectCanonicalCancellation(
  error: ProjectCommandToolError,
  outcome: ProjectCommandExecutionOutcome,
): void {
  expectInvocationMetadata(error.details, "returned-outcome-cancellation");
  expect(error).toMatchObject({
    name: "AbortError",
    message: "Project command request cancelled",
    contract: {
      code: "cancelled",
      category: "CANCELLED",
      retryable: true,
      executed: true,
    },
    details: {
      commandId: "workspace_path",
      projectPath: expect.any(String),
      fingerprint: expect.any(String),
      scope: {
        cwdStrategy: "canonical-project",
        projectPath: expect.any(String),
      },
      resolvedCommand: expect.any(String),
      parameters: {},
      status: "cancelled",
      suggestedAction: expect.any(String),
      category: "CANCELLED",
      executed: true,
      exit: { code: null, signal: null },
      timedOut: false,
      cancelled: true,
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
      projectInfo: outcome.structuredDetails,
      error: { code: "cancelled", category: "CANCELLED" },
    },
  });
  expect(error.details).not.toMatchObject({
    exit: outcome.exit,
    timedOut: outcome.timedOut,
    cancelled: outcome.cancelled,
    executed: outcome.executed,
  });
  if (outcome.status !== "cancelled") {
    expect(error.details).not.toMatchObject({ status: outcome.status });
  }
}

it("normalizes cancellation when an aborted executor resolves success", async () => {
  const outcome = {
    status: "success" as const,
    exit: { code: 0, signal: null },
    timedOut: false,
    cancelled: false,
    executed: false,
    stdout: { text: "success partial", truncated: true, totalBytes: 80, totalLines: 2 },
    stderr: { text: "success warning", truncated: false, totalBytes: 15, totalLines: 1 },
    structuredDetails: { marker: "success-details" },
  } satisfies ProjectCommandExecutionOutcome;
  expectCanonicalCancellation(await executeInjectedOutcome(outcome, true), outcome);
});

it("normalizes cancellation when an aborted executor resolves nonzero", async () => {
  const outcome = {
    status: "nonzero" as const,
    exit: { code: 23, signal: "SIGTERM" },
    timedOut: true,
    cancelled: false,
    executed: false,
    stdout: { text: "nonzero partial", truncated: true, totalBytes: 96, totalLines: 3 },
    stderr: { text: "nonzero diagnostics", truncated: true, totalBytes: 120, totalLines: 4 },
    structuredDetails: { marker: "nonzero-details" },
  } satisfies ProjectCommandExecutionOutcome;
  expectCanonicalCancellation(await executeInjectedOutcome(outcome, true), outcome);
});

it("normalizes cancellation when an aborted executor resolves timeout", async () => {
  const outcome = {
    status: "timeout" as const,
    exit: { code: 7, signal: "SIGKILL" },
    timedOut: true,
    cancelled: false,
    executed: false,
    stdout: { text: "timeout partial", truncated: true, totalBytes: 110, totalLines: 5 },
    stderr: { text: "timeout diagnostics", truncated: false, totalBytes: 19, totalLines: 1 },
    structuredDetails: { marker: "timeout-details" },
  } satisfies ProjectCommandExecutionOutcome;
  expectCanonicalCancellation(await executeInjectedOutcome(outcome, true), outcome);
});

it("normalizes an explicit malformed cancelled executor outcome", async () => {
  const outcome = {
    status: "cancelled" as const,
    exit: { code: 9, signal: "SIGABRT" },
    timedOut: true,
    cancelled: false,
    executed: false,
    stdout: { text: "cancelled partial", truncated: true, totalBytes: 128, totalLines: 6 },
    stderr: { text: "cancelled diagnostics", truncated: false, totalBytes: 21, totalLines: 1 },
    structuredDetails: { marker: "cancelled-details" },
  } satisfies ProjectCommandExecutionOutcome;
  expectCanonicalCancellation(await executeInjectedOutcome(outcome, false), outcome);
});

it("returns Fallow findings with exit code one as normal command data", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("fallow_health");
  if (definition === undefined) throw new Error("missing fallow_health definition");
  const resolved = {
    ...resolveFixedProjectCommand(definition),
    executable: process.execPath,
    args: ["/project/node_modules/fallow/bin/fallow", ...definition.args],
    fingerprintArgs: definition.argvTemplate,
  } satisfies ResolvedProjectCommand;
  await authorize(fixtureData, definition, resolved);
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    resolver: async () => resolved,
    executor: async () => ({
      status: "nonzero" as const,
      exit: { code: 1, signal: null },
      timedOut: false,
      cancelled: false,
      stdout: {
        text: '{"kind":"health","findings":[{}]}',
        truncated: false,
        totalBytes: 34,
        totalLines: 1,
      },
      stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
    }),
  });
  const response = await tool.execute(
    "fallow-health",
    { commandId: "fallow_health" },
    undefined,
    undefined,
    context(fixtureData.directory),
  );
  expect(response.details).toMatchObject({
    commandId: "fallow_health",
    status: "nonzero",
    category: "PASS",
    executed: true,
    toolCallId: "fallow-health",
    reused: false,
    durationMs: expect.any(Number),
    executionDurationMs: expect.any(Number),
    scope: {
      cwdStrategy: "canonical-project",
      projectPath: await realpath(fixtureData.directory),
    },
    output: {
      stdout: { truncated: false, totalBytes: 34, totalLines: 1 },
      stderr: { truncated: false, totalBytes: 0, totalLines: 0 },
    },
    exit: { code: 1, signal: null },
    stdout: { text: '{"kind":"health","findings":[{}]}' },
    resolvedCommand: expect.stringContaining("health --format json --quiet"),
    parameters: {},
  });
  expect(response.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining('"resolvedCommand":"'),
  });
  expect(response.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining('"parameters":{}'),
  });
  expect(response.details).not.toHaveProperty("diagnostic");
  expect(response.details).not.toHaveProperty("suggestedAction");
  expect(response.details).not.toHaveProperty("error");
  expectInvocationMetadata(response.details, "fallow-health");
});

it("keeps exit code two as a Fallow execution failure", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("fallow_health");
  if (definition === undefined) throw new Error("missing fallow_health definition");
  const resolved = {
    ...resolveFixedProjectCommand(definition),
    executable: process.execPath,
    args: ["/project/node_modules/fallow/bin/fallow", ...definition.args],
    fingerprintArgs: definition.argvTemplate,
  } satisfies ResolvedProjectCommand;
  await authorize(fixtureData, definition, resolved);
  const records: ProjectCommandInvocationRecord[] = [];
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    resolver: async () => resolved,
    invocationRecorder: (record) => records.push(record),
    executor: async () => ({
      status: "nonzero" as const,
      exit: { code: 2, signal: null },
      timedOut: false,
      cancelled: false,
      stdout: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
      stderr: { text: "invalid options", truncated: false, totalBytes: 15, totalLines: 1 },
    }),
  });
  const error = await tool
    .execute(
      "fallow-health-failure",
      { commandId: "fallow_health" },
      undefined,
      undefined,
      context(fixtureData.directory, {
        sessionManager: { getSessionId: () => "failure-session" },
      }),
    )
    .catch((rejection: unknown) => rejection);
  expect(records).toMatchObject([
    {
      sessionId: "failure-session",
      toolCallId: "fallow-health-failure",
      resultCategory: "IMPLEMENTATION_FAILURE",
      status: "nonzero",
      executed: true,
      cacheDecision: "ineligible",
      reason: "executed-cache-ineligible",
      output: { stderr: { totalBytes: 15, truncated: false } },
    },
  ]);
  expect(error).toMatchObject({
    message: expect.stringMatching(
      /status: nonzero.*commandId: fallow_health.*resolvedCommand: .*health --format json --quiet.*parameters: \{\}.*exit: code 2.*diagnostic: "invalid options"/u,
    ),
    details: {
      commandId: "fallow_health",
      status: "nonzero",
      category: "IMPLEMENTATION_FAILURE",
      executed: true,
      toolCallId: "fallow-health-failure",
      reused: false,
      durationMs: expect.any(Number),
      executionDurationMs: expect.any(Number),
      diagnostic: "invalid options",
      suggestedAction: "Inspect the command diagnostics before retrying the request.",
      error: {
        code: "command-nonzero",
        suggestedAction: "Inspect the command diagnostics before retrying the request.",
        category: "IMPLEMENTATION_FAILURE",
        retryable: true,
        executed: true,
      },
      resolvedCommand: expect.stringContaining("health --format json --quiet"),
      parameters: {},
      exit: { code: 2, signal: null },
      stderr: { text: "invalid options" },
    },
  });
});

function capturingEvidenceStore(): ProjectCommandEvidenceStore {
  let stored: ProjectCommandEvidenceRecord | undefined;
  return {
    getByRef: (ref) => (stored?.ref === ref ? stored : undefined),
    set: (record) => {
      stored = record;
      return true;
    },
    publish: () => false,
    clear: () => {
      stored = undefined;
    },
  };
}

function failingFallowHealthExecutor(): () => Promise<ProjectCommandExecutionOutcome> {
  return async () => ({
    status: "nonzero" as const,
    exit: { code: 2, signal: null },
    timedOut: false,
    cancelled: false,
    stdout: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
    stderr: { text: "invalid options", truncated: false, totalBytes: 15, totalLines: 1 },
  });
}

async function expectProjectCommandToolError(
  promise: Promise<unknown>,
): Promise<ProjectCommandToolError> {
  const error = await promise.catch((rejection: unknown) => rejection);
  expect(error).toBeInstanceOf(ProjectCommandToolError);
  if (!(error instanceof ProjectCommandToolError)) {
    throw new Error("expected a ProjectCommandToolError");
  }
  return error;
}

function storedRef(error: ProjectCommandToolError): string {
  const details = error.details;
  if (typeof details !== "object" || details === null || !("ref" in details)) {
    throw new Error("expected a stored evidence reference");
  }
  const ref = details.ref;
  if (typeof ref !== "string") throw new Error("expected a stored evidence reference");
  return ref;
}

it("reports the stored evidence reference after the reason segment of a failing execution", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("fallow_health");
  if (definition === undefined) throw new Error("missing fallow_health definition");
  const resolved = {
    ...resolveFixedProjectCommand(definition),
    executable: process.execPath,
    args: ["/project/node_modules/fallow/bin/fallow", ...definition.args],
    fingerprintArgs: definition.argvTemplate,
  } satisfies ResolvedProjectCommand;
  await authorize(fixtureData, definition, resolved);
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    evidence: capturingEvidenceStore(),
    resolver: async () => resolved,
    executor: failingFallowHealthExecutor(),
  });
  const error = await expectProjectCommandToolError(
    tool.execute(
      "failure-with-ref",
      { commandId: "fallow_health" },
      undefined,
      undefined,
      context(fixtureData.directory),
    ),
  );
  const ref = storedRef(error);
  const resolvedCommand = [resolved.executable, ...resolved.args].join(" ");
  expect(error.message).toBe(
    `Project command failed; status: nonzero; reason: the command exited with a nonzero status; ref: ${ref}; commandId: fallow_health; resolvedCommand: ${resolvedCommand}; parameters: {}; exit: code 2; diagnostic: "invalid options"`,
  );
  expect(error).toMatchObject({
    contract: {
      code: "command-nonzero",
      category: "IMPLEMENTATION_FAILURE",
      retryable: true,
      executed: true,
    },
    details: {
      commandId: "fallow_health",
      status: "nonzero",
      category: "IMPLEMENTATION_FAILURE",
      executed: true,
      toolCallId: "failure-with-ref",
      ref,
      diagnostic: "invalid options",
      exit: { code: 2, signal: null },
      stderr: { text: "invalid options" },
    },
  });
  expect(error.message).not.toContain("publication");
  expect(error.message).not.toContain("covers");
});

it("keeps the failure message unchanged when no evidence is stored", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("fallow_health");
  if (definition === undefined) throw new Error("missing fallow_health definition");
  const resolved = {
    ...resolveFixedProjectCommand(definition),
    executable: process.execPath,
    args: ["/project/node_modules/fallow/bin/fallow", ...definition.args],
    fingerprintArgs: definition.argvTemplate,
  } satisfies ResolvedProjectCommand;
  await authorize(fixtureData, definition, resolved);
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    resolver: async () => resolved,
    executor: failingFallowHealthExecutor(),
  });
  const error = await expectProjectCommandToolError(
    tool.execute(
      "failure-without-ref",
      { commandId: "fallow_health" },
      undefined,
      undefined,
      context(fixtureData.directory),
    ),
  );
  const resolvedCommand = [resolved.executable, ...resolved.args].join(" ");
  expect(error.message).toBe(
    `Project command failed; status: nonzero; reason: the command exited with a nonzero status; commandId: fallow_health; resolvedCommand: ${resolvedCommand}; parameters: {}; exit: code 2; diagnostic: "invalid options"`,
  );
  expect(error.message).not.toContain("ref:");
  expect(error.details).not.toHaveProperty("ref");
});

it("keeps the stored evidence reference in a truncated failure message", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("node_test");
  if (definition === undefined) throw new Error("missing node_test definition");
  const resolved = {
    ...resolveFixedProjectCommand(definition),
    executable: process.execPath,
    args: ["-e", "process.exit(1)"],
    displayCommand: `${process.execPath} -e process.exit(1)`,
    effectiveParameters: {},
  } satisfies ResolvedProjectCommand;
  await authorize(fixtureData, definition, resolved);
  const longDiagnostic = `failure: ${"x".repeat(2_100)}`;
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    evidence: capturingEvidenceStore(),
    resolver: async () => resolved,
    executor: async () => ({
      status: "nonzero" as const,
      exit: { code: 1, signal: null },
      timedOut: false,
      cancelled: false,
      executed: true,
      stdout: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
      stderr: {
        text: longDiagnostic,
        truncated: false,
        totalBytes: Buffer.byteLength(longDiagnostic),
        totalLines: 1,
      },
    }),
  });
  const error = await expectProjectCommandToolError(
    tool.execute(
      "failure-truncated-with-ref",
      { commandId: "node_test" },
      undefined,
      undefined,
      context(fixtureData.directory),
    ),
  );
  const ref = storedRef(error);
  expect(error.message.length).toBeLessThanOrEqual(PROJECT_COMMAND_DIAGNOSTIC_MAX_CHARS);
  expect(error.message).toContain(
    `reason: the command exited with a nonzero status; ref: ${ref}; commandId: node_test;`,
  );
  expect(error.message).not.toContain(longDiagnostic);
  expect(error.details).toMatchObject({
    ref,
    diagnostic: expect.stringMatching(/^failure: x+\.\.\.$/u),
  });
});

it("reports the stored evidence reference in an executed cancellation message", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("workspace_path");
  if (definition === undefined) throw new Error("missing workspace_path definition");
  const resolved = resolveFixedProjectCommand(definition);
  await authorize(fixtureData, definition, resolved);
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    evidence: capturingEvidenceStore(),
    executor: async () => ({
      status: "cancelled" as const,
      exit: { code: null, signal: "SIGTERM" },
      timedOut: false,
      cancelled: true,
      stdout: { text: "partial", truncated: true, totalBytes: 100, totalLines: 2 },
      stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
    }),
  });
  const error = await expectProjectCommandToolError(
    tool.execute(
      "cancellation-with-ref",
      { commandId: "workspace_path" },
      undefined,
      undefined,
      context(fixtureData.directory),
    ),
  );
  const ref = storedRef(error);
  expect(error).toMatchObject({
    name: "AbortError",
    message: `Project command request cancelled; ref: ${ref}`,
    contract: { code: "cancelled", category: "CANCELLED", retryable: true, executed: true },
    details: {
      commandId: "workspace_path",
      status: "cancelled",
      category: "CANCELLED",
      executed: true,
      cancelled: true,
      toolCallId: "cancellation-with-ref",
      ref,
    },
  });
  expect(error.message).not.toContain("publication");
});

it("keeps the pre-execution cancellation message unchanged without evidence", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("workspace_path");
  if (definition === undefined) throw new Error("missing workspace_path definition");
  const resolved = resolveFixedProjectCommand(definition);
  await authorize(fixtureData, definition, resolved);
  const controller = new AbortController();
  controller.abort();
  let executorCalls = 0;
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    executor: async () => {
      executorCalls += 1;
      return {
        status: "success" as const,
        exit: { code: 0, signal: null },
        timedOut: false,
        cancelled: false,
        stdout: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
        stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
      };
    },
  });
  const error = await expectProjectCommandToolError(
    tool.execute(
      "pre-execution-cancel",
      { commandId: "workspace_path" },
      controller.signal,
      undefined,
      context(fixtureData.directory),
    ),
  );
  expect(error).toMatchObject({
    name: "AbortError",
    message: "Project command request cancelled",
    contract: { code: "cancelled", category: "CANCELLED", retryable: true, executed: false },
  });
  expect(error.details).not.toHaveProperty("ref");
  expect(executorCalls).toBe(0);
});

it("keeps the T-003 model content projection when evidence is stored", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("workspace_path");
  if (definition === undefined) throw new Error("missing workspace_path definition");
  const resolved = resolveFixedProjectCommand(definition);
  await authorize(fixtureData, definition, resolved);
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    evidence: capturingEvidenceStore(),
    executor: async () => ({
      status: "success" as const,
      exit: { code: 0, signal: null },
      timedOut: false,
      cancelled: false,
      stdout: { text: "workspace", truncated: false, totalBytes: 9, totalLines: 1 },
      stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
    }),
  });
  const response = await tool.execute(
    "content-with-ref",
    { commandId: "workspace_path" },
    undefined,
    undefined,
    context(fixtureData.directory),
  );
  const ref = response.details.ref;
  if (typeof ref !== "string") throw new Error("expected a stored evidence reference");
  expect(response.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining(`"ref":"${ref}"`),
  });
});

it("uses the cleaned bounded Node diagnostic in the failure message while preserving raw output", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("node_test");
  if (definition === undefined) throw new Error("missing node_test definition");
  const resolved = {
    ...resolveFixedProjectCommand(definition),
    executable: process.execPath,
    args: ["-e", "process.exit(1)"],
    displayCommand: `${process.execPath} -e process.exit(1)`,
    effectiveParameters: {},
  } satisfies ResolvedProjectCommand;
  await authorize(fixtureData, definition, resolved);
  const longDiagnostic = `failure: ${"x".repeat(2_100)}`;
  const c1OscPayload = "https://example.test/secret";
  const c1ControlPayload = "C1 DCS secret";
  const rawStderr = `\u009b31m\u009d8;;${c1OscPayload}\u0007\u0090${c1ControlPayload}\u009c\u001b[31m> @scope/pkg@1.2.3 test\u001b[0m\r\n${longDiagnostic}\u0007`;
  const rawStdout = "\u001b[33mstdout fallback\u001b[0m\r\n";
  const expectedDiagnostic = `${longDiagnostic.slice(0, PROJECT_COMMAND_DIAGNOSTIC_MAX_CHARS - 3)}...`;
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    resolver: async () => resolved,
    executor: async () => ({
      status: "nonzero" as const,
      exit: { code: 1, signal: null },
      timedOut: false,
      cancelled: false,
      executed: true,
      stdout: {
        text: rawStdout,
        truncated: false,
        totalBytes: Buffer.byteLength(rawStdout),
        totalLines: 1,
      },
      stderr: {
        text: rawStderr,
        truncated: false,
        totalBytes: Buffer.byteLength(rawStderr),
        totalLines: 2,
      },
    }),
  });
  const error = await tool
    .execute(
      "node-test-diagnostic",
      { commandId: "node_test" },
      undefined,
      undefined,
      context(fixtureData.directory),
    )
    .catch((rejection: unknown) => rejection);
  expect(error).toBeInstanceOf(ProjectCommandToolError);
  if (!(error instanceof ProjectCommandToolError)) {
    throw new Error("expected a ProjectCommandToolError");
  }
  expect(error.details).toMatchObject({
    commandId: "node_test",
    status: "nonzero",
    category: "TEST_FAILURE",
    diagnostic: expectedDiagnostic,
    stdout: { text: rawStdout },
    stderr: { text: rawStderr },
  });
  expect(error.message).toContain('diagnostic: "failure: ');
  expect(error.message.length).toBeLessThanOrEqual(PROJECT_COMMAND_DIAGNOSTIC_MAX_CHARS);
  expect(hasEscapeOrC1Control(error.message)).toBe(false);
  expect(error.message).not.toContain("\u009b");
  expect(error.message).not.toContain("\u009d");
  expect(error.message).not.toContain(c1OscPayload);
  expect(error.message).not.toContain(c1ControlPayload);
  expect(error.message).not.toContain("@scope/pkg@1.2.3 test");
  expect(error.message).not.toContain(longDiagnostic);
  expect(error.message).not.toContain(rawStderr);
});

it("sanitizes C1 controls in resolved commands and parameters before bounding failures", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("node_test");
  if (definition === undefined) throw new Error("missing node_test definition");
  const resolvedPayload = "https://resolved-command-secret.test";
  const parameterPayload = "https://parameter-secret.test";
  const rawResolvedCommand = `${process.execPath} -e process.exit(1) \u001b]8;;${resolvedPayload}\u0007`;
  const rawParameter = `before\u009d8;;${parameterPayload}\u0007after`;
  const resolved = {
    ...resolveFixedProjectCommand(definition),
    executable: process.execPath,
    args: ["-e", "process.exit(1)"],
    displayCommand: rawResolvedCommand,
    effectiveParameters: { value: rawParameter, padding: "x".repeat(5_000) },
  } satisfies ResolvedProjectCommand;
  await authorize(fixtureData, definition, resolved);
  const rawStdout = "raw\u009bstdout";
  const rawStderr = "\u009b31m\u009d8;;https://diagnostic-secret.test\u0007boom\u009c";
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    resolver: async () => resolved,
    executor: async () => ({
      status: "nonzero" as const,
      exit: { code: 1, signal: null },
      timedOut: false,
      cancelled: false,
      executed: true,
      stdout: {
        text: rawStdout,
        truncated: false,
        totalBytes: Buffer.byteLength(rawStdout),
        totalLines: 1,
      },
      stderr: {
        text: rawStderr,
        truncated: false,
        totalBytes: Buffer.byteLength(rawStderr),
        totalLines: 1,
      },
    }),
  });
  const error = await tool
    .execute(
      "c1-execution-failure",
      { commandId: "node_test" },
      undefined,
      undefined,
      context(fixtureData.directory),
    )
    .catch((rejection: unknown) => rejection);
  expect(error).toBeInstanceOf(ProjectCommandToolError);
  if (!(error instanceof ProjectCommandToolError)) {
    throw new Error("expected a ProjectCommandToolError");
  }
  expect(error.details).toMatchObject({
    diagnostic: "boom",
    stdout: { text: rawStdout },
    stderr: { text: rawStderr },
  });
  expect(error.message.length).toBeLessThanOrEqual(PROJECT_COMMAND_DIAGNOSTIC_MAX_CHARS);
  expect(hasEscapeOrC1Control(error.message)).toBe(false);
  expect(error.message).not.toContain(resolvedPayload);
  expect(error.message).not.toContain(parameterPayload);
  expect(error.message).not.toContain("diagnostic-secret.test");
});

it("includes timeout diagnostics with resolved parameters and stdout fallback", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("fallow_audit");
  if (definition === undefined) throw new Error("missing fallow_audit definition");
  const resolved = {
    ...resolveFixedProjectCommand(definition),
    executable: "/bin/fallow",
    args: ["audit", "--format", "json", "--quiet", "--base", "HEAD~1"],
    effectiveParameters: { base: "HEAD~1" },
  } satisfies ResolvedProjectCommand;
  await authorize(fixtureData, definition, resolved);
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    resolver: async () => resolved,
    executor: async () => ({
      status: "timeout" as const,
      exit: { code: null, signal: "SIGTERM" },
      timedOut: true,
      cancelled: false,
      stdout: { text: "diagnostic output", truncated: false, totalBytes: 16, totalLines: 1 },
      stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
    }),
  });
  await expect(
    tool.execute(
      "fallow-audit-timeout",
      { commandId: "fallow_audit", base: "HEAD~1" },
      undefined,
      undefined,
      context(fixtureData.directory),
    ),
  ).rejects.toMatchObject({
    message: expect.stringMatching(
      /status: timeout.*reason: the command timed out.*commandId: fallow_audit.*resolvedCommand: \/bin\/fallow audit --format json --quiet --base HEAD~1.*parameters: \{"base":"HEAD~1"\}.*exit: signal SIGTERM.*diagnostic: "diagnostic output"/u,
    ),
    details: {
      status: "timeout",
      category: "TIMEOUT",
      executed: true,
      toolCallId: "fallow-audit-timeout",
      reused: false,
      durationMs: expect.any(Number),
      executionDurationMs: expect.any(Number),
      diagnostic: "diagnostic output",
      suggestedAction: "Review the command duration and project state before retrying the request.",
      commandId: "fallow_audit",
      error: {
        code: "process-timeout",
        category: "TIMEOUT",
        suggestedAction:
          "Review the command duration and project state before retrying the request.",
        retryable: true,
        executed: true,
      },
      resolvedCommand: "/bin/fallow audit --format json --quiet --base HEAD~1",
      parameters: { base: "HEAD~1" },
      exit: { code: null, signal: "SIGTERM" },
      stdout: { text: "diagnostic output" },
    },
  });
});

it("classifies a spawn failure with a structured execution error", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("workspace_path");
  if (definition === undefined) throw new Error("missing workspace_path definition");
  const resolved = resolveFixedProjectCommand(definition);
  await authorize(fixtureData, definition, resolved);
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    executor: async () => ({
      status: "spawn-failure" as const,
      exit: { code: null, signal: null },
      timedOut: false,
      cancelled: false,
      executed: true,
      stdout: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
      stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
    }),
  });
  await expect(
    tool.execute(
      "spawn",
      { commandId: "workspace_path" },
      undefined,
      undefined,
      context(fixtureData.directory),
    ),
  ).rejects.toMatchObject({
    contract: {
      code: "spawn-failure",
      category: "SPAWN_FAILURE",
      retryable: true,
      executed: true,
    },
    details: {
      category: "SPAWN_FAILURE",
      executed: true,
      toolCallId: "spawn",
      reused: false,
      durationMs: expect.any(Number),
      executionDurationMs: expect.any(Number),
      suggestedAction:
        "Verify that the required executable and project dependencies are available, then retry.",
      error: {
        code: "spawn-failure",
        category: "SPAWN_FAILURE",
        suggestedAction:
          "Verify that the required executable and project dependencies are available, then retry.",
      },
    },
  });
});

it("prefers cancellation when the executor rejects after the request is aborted", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("workspace_path");
  if (definition === undefined) throw new Error("missing workspace_path definition");
  const resolved = resolveFixedProjectCommand(definition);
  await authorize(fixtureData, definition, resolved);
  const controller = new AbortController();
  const rawMessage = "raw executor rejection";
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    executor: async () => {
      controller.abort();
      throw new Error(rawMessage);
    },
  });
  const error = await tool
    .execute(
      "abort-then-reject",
      { commandId: "workspace_path" },
      controller.signal,
      undefined,
      context(fixtureData.directory),
    )
    .catch((rejection: unknown) => rejection);
  expect(error).toMatchObject({
    name: "AbortError",
    message: "Project command request cancelled",
    contract: {
      code: "cancelled",
      category: "CANCELLED",
      retryable: true,
      executed: true,
    },
    details: {
      status: "cancelled",
      category: "CANCELLED",
      executed: true,
      exit: { code: null, signal: null },
      timedOut: false,
      cancelled: true,
      toolCallId: "abort-then-reject",
      reused: false,
      durationMs: expect.any(Number),
      executionDurationMs: expect.any(Number),
      suggestedAction: "Retry the request if the command is still needed.",
      error: { code: "cancelled", category: "CANCELLED" },
    },
  });
  expect(error).toBeInstanceOf(ProjectCommandToolError);
  if (!(error instanceof ProjectCommandToolError)) {
    throw new Error("expected a ProjectCommandToolError");
  }
  expectInvocationMetadata(error.details, "abort-then-reject");
  expect(JSON.stringify(error.details)).not.toContain(rawMessage);
});

it("sanitizes a non-cancellation executor rejection as an implementation failure", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("workspace_path");
  if (definition === undefined) throw new Error("missing workspace_path definition");
  const resolved = resolveFixedProjectCommand(definition);
  await authorize(fixtureData, definition, resolved);
  const rawMessage = "raw executor rejection";
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    executor: async () => {
      throw Object.assign(new Error(rawMessage), { cause: { secret: "do not expose" } });
    },
  });
  const error = await tool
    .execute(
      "executor-rejects",
      { commandId: "workspace_path" },
      undefined,
      undefined,
      context(fixtureData.directory),
    )
    .catch((rejection: unknown) => rejection);
  expect(error).toMatchObject({
    name: "ProjectCommandToolError",
    message: "Project command executor failed",
    contract: {
      code: "executor-failure",
      category: "IMPLEMENTATION_FAILURE",
      explanation: "The project command executor failed.",
      retryable: false,
      executed: true,
    },
    details: {
      category: "IMPLEMENTATION_FAILURE",
      executed: true,
      error: {
        code: "executor-failure",
        category: "IMPLEMENTATION_FAILURE",
        explanation: "The project command executor failed.",
        retryable: false,
        executed: true,
      },
    },
  });
  expect(error).toBeInstanceOf(ProjectCommandToolError);
  if (!(error instanceof ProjectCommandToolError)) {
    throw new Error("expected a ProjectCommandToolError");
  }
  expect(error.details).toMatchObject({
    category: "IMPLEMENTATION_FAILURE",
    executed: true,
    toolCallId: "executor-rejects",
    reused: false,
    durationMs: expect.any(Number),
    executionDurationMs: expect.any(Number),
    suggestedAction: "Inspect the command diagnostics before retrying the request.",
    error: {
      code: "executor-failure",
      category: "IMPLEMENTATION_FAILURE",
      explanation: "The project command executor failed.",
      suggestedAction: "Inspect the command diagnostics before retrying the request.",
      retryable: false,
      executed: true,
    },
  });
  expectInvocationMetadata(error.details, "executor-rejects");
  expect(JSON.stringify(error)).not.toContain(rawMessage);
  expect(JSON.stringify(error)).not.toContain("do not expose");
});

it("returns bounded execution details and marks execution cancellation as abort", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("workspace_path");
  if (definition === undefined) throw new Error("missing workspace_path definition");
  const resolved = resolveFixedProjectCommand(definition);
  await authorize(fixtureData, definition, resolved);
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    executor: async () => ({
      status: "cancelled" as const,
      exit: { code: null, signal: "SIGTERM" },
      timedOut: false,
      cancelled: true,
      stdout: { text: "partial", truncated: true, totalBytes: 100, totalLines: 2 },
      stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
    }),
  });
  await expect(
    tool.execute(
      "1",
      { commandId: "workspace_path" },
      undefined,
      undefined,
      context(fixtureData.directory),
    ),
  ).rejects.toMatchObject({
    name: "AbortError",
    contract: {
      code: "cancelled",
      category: "CANCELLED",
      executed: true,
    },
    details: {
      commandId: "workspace_path",
      cancelled: true,
      category: "CANCELLED",
      executed: true,
      toolCallId: "1",
      reused: false,
      durationMs: expect.any(Number),
      executionDurationMs: expect.any(Number),
      suggestedAction: "Retry the request if the command is still needed.",
      error: { code: "cancelled", category: "CANCELLED" },
    },
  });
});
