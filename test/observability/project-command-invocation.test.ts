/* oxlint-disable typescript/no-unsafe-type-assertion */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  BASH_TOOLS_INVOCATIONS_PATH,
  buildProjectCommandInvocationRecord,
  createProjectCommandInvocationRecorder,
  createProjectCommandInvocationSessionRecorder,
  PROJECT_COMMAND_INVOCATION_ENTRY_TYPE,
  PROJECT_COMMAND_INVOCATION_MAX_BYTES,
  PROJECT_COMMAND_SUMMARY_ENTRY_TYPE,
  PROJECT_COMMAND_SUMMARY_MAX_BYTES,
  PROJECT_COMMAND_SUMMARY_MAX_COUNT,
  PROJECT_COMMAND_SUMMARY_MAX_SCHEMA_HASHES,
  recordProjectCommandInvocation,
  summarizeProjectCommandInvocations,
  type ProjectCommandInvocationRecordInput,
} from "../../src/observability/project-command-invocation.ts";

function input(
  overrides: Partial<ProjectCommandInvocationRecordInput> = {},
): ProjectCommandInvocationRecordInput {
  return {
    sessionId: "session-1",
    toolCallId: "call-1",
    schemaHash: "schema-hash",
    commandId: "node_test",
    parameters: {
      commandId: "node_test",
      variant: "unit",
      paths: ["private/source-file.ts"],
    },
    resultCategory: "PASS",
    status: "success",
    executed: true,
    reason: "executed-after-cache-miss",
    cacheDecision: "miss",
    forced: false,
    reused: false,
    durationMs: 12.8,
    executionDurationMs: 8.4,
    output: {
      stdout: { truncated: true, totalBytes: 123_456, totalLines: 100 },
      stderr: { truncated: false, totalBytes: 20, totalLines: 1 },
    },
    ...overrides,
  };
}

describe("project command invocation metadata", () => {
  it("records identity, schema, result, timing, cache, output, and truncation metadata", () => {
    const record = buildProjectCommandInvocationRecord(input());

    expect(record).toMatchObject({
      invocationFormatVersion: 1,
      sessionId: "session-1",
      toolCallId: "call-1",
      schemaHash: "schema-hash",
      commandId: "node_test",
      resultCategory: "PASS",
      status: "success",
      executed: true,
      reason: "executed-after-cache-miss",
      cacheDecision: "miss",
      forced: false,
      reused: false,
      durationMs: 12,
      executionDurationMs: 8,
      output: {
        stdout: { truncated: true, totalBytes: 123_456, totalLines: 100 },
        stderr: { truncated: false, totalBytes: 20, totalLines: 1 },
      },
    });
  });

  it("normalizes malformed enum, identifier, numeric, and stream metadata", () => {
    const malformed = {
      ...input(),
      sessionId: "s".repeat(300),
      toolCallId: "t".repeat(300),
      schemaHash: "h".repeat(300),
      resultCategory: "not-a-category",
      status: "not-a-status",
      reason: "not-a-reason",
      cacheDecision: "not-a-cache-decision",
      durationMs: Number.NaN,
      executionDurationMs: Number.POSITIVE_INFINITY,
      output: {
        stdout: { truncated: 1, totalBytes: -1, totalLines: Number.POSITIVE_INFINITY },
        stderr: { truncated: "yes", totalBytes: Number.NaN, totalLines: 1.9 },
      },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    } as unknown as ProjectCommandInvocationRecordInput;

    const record = buildProjectCommandInvocationRecord(malformed);

    expect(record.sessionId).toHaveLength(256);
    expect(record.toolCallId).toHaveLength(256);
    expect(record.schemaHash).toHaveLength(256);
    expect(record.resultCategory).toBe("IMPLEMENTATION_FAILURE");
    expect(record.status).toBeUndefined();
    expect(record.reason).toBe("preparation-failure");
    expect(record.cacheDecision).toBe("ineligible");
    expect(record.durationMs).toBe(0);
    expect(record.executionDurationMs).toBe(0);
    expect(record.output).toEqual({
      stdout: { truncated: false, totalBytes: 0, totalLines: 0 },
      stderr: { truncated: false, totalBytes: 0, totalLines: 1 },
    });
  });

  it("redacts parameter values while preserving bounded command metadata", () => {
    const record = buildProjectCommandInvocationRecord(
      input({
        parameters: {
          commandId: "c".repeat(300),
          variant: "v".repeat(300),
          secret: "private prompt",
          flag: true,
          count: 42,
          empty: null,
          paths: ["private/source.ts", "private/other.ts"],
          object: { password: "hidden" },
        },
      }),
    );

    expect(record.parameters).toMatchObject({
      commandId: `${"c".repeat(255)}…`,
      variant: `${"v".repeat(255)}…`,
      secret: { hash: expect.any(String), length: 14 },
      flag: true,
      count: 42,
      empty: { type: "null" },
      paths: { count: 2, hashes: [expect.any(String), expect.any(String)] },
      object: { hash: expect.any(String), type: "object" },
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("private/source.ts");
    expect(serialized).not.toContain("hidden");
  });

  it("falls back to a minimal bounded record for oversized or cyclic fields", () => {
    const oversized = buildProjectCommandInvocationRecord(
      input({
        redactedParameters: { oversized: "x".repeat(PROJECT_COMMAND_INVOCATION_MAX_BYTES) },
      }),
    );
    expect(oversized.parameters).toBeUndefined();
    expect(oversized.commandId).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(oversized), "utf8")).toBeLessThanOrEqual(
      PROJECT_COMMAND_INVOCATION_MAX_BYTES,
    );

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const malformed = buildProjectCommandInvocationRecord(input({ redactedParameters: cyclic }));
    expect(malformed.parameters).toBeUndefined();
    expect(malformed.commandId).toBeUndefined();
    expect(malformed.output).toEqual(input().output);
  });

  it("bounds optional orchestration, state, publication, and coercion metadata", () => {
    const record = buildProjectCommandInvocationRecord(
      input({
        flowId: "flow-".repeat(100),
        delegationId: "delegation-".repeat(100),
        role: "role-".repeat(100),
        ref: "ref-".repeat(100),
        repositoryState: {
          repositoryIdentity: "repo-".repeat(100),
          head: "head-".repeat(100),
          dirtyFilesDigest: "digest-".repeat(100),
          readable: true,
          stateMatchesCurrent: false,
        },
        verdict: "incomplete",
        mutating: true,
        publication: {
          scope: "flow",
          flowId: "flow-".repeat(100),
          published: true,
          error: "error-".repeat(100),
        },
        coercions: Array.from({ length: 100 }, () => "paths:string-json-array"),
        concurrentExecutions: Number.MAX_SAFE_INTEGER,
        stateDrift: true,
        aggregate: true,
      }),
    );

    expect(record).toMatchObject({
      flowId: expect.any(String),
      delegationId: expect.any(String),
      role: expect.any(String),
      ref: expect.any(String),
      repositoryState: {
        readable: true,
        stateMatchesCurrent: false,
      },
      verdict: "incomplete",
      mutating: true,
      publication: { scope: "flow", published: true },
      coercions: expect.arrayContaining(["paths:string-json-array"]),
      concurrentExecutions: 9_999_999_999,
      stateDrift: true,
      aggregate: true,
    });
    expect(record.flowId).toHaveLength(256);
    expect(record.repositoryState?.repositoryIdentity).toHaveLength(256);
    expect(record.coercions).toHaveLength(16);
    expect(Buffer.byteLength(JSON.stringify(record), "utf8")).toBeLessThanOrEqual(
      PROJECT_COMMAND_INVOCATION_MAX_BYTES,
    );
  });

  it("hashes sensitive arguments and bounds the complete persisted shape", () => {
    const record = buildProjectCommandInvocationRecord(
      input({
        sessionId: "s".repeat(10_000),
        toolCallId: "t".repeat(10_000),
        parameters: {
          commandId: "node_test",
          variant: "unit",
          paths: Array.from({ length: 100 }, (_, index) => `private-${index}.ts`),
        },
      }),
    );
    const serialized = JSON.stringify(record);

    expect(serialized).not.toContain("private-0.ts");
    expect(serialized).not.toContain("secret-title");
    expect(serialized).not.toContain("source-file.ts");
    expect(serialized).not.toContain("resolvedCommand");
    expect(serialized).not.toContain("complete output");
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
      PROJECT_COMMAND_INVOCATION_MAX_BYTES,
    );
    expect(record.sessionId).toHaveLength(256);
    expect(record.toolCallId).toHaveLength(256);
    expect(record.parameters).toMatchObject({
      commandId: "node_test",
      variant: "unit",
      paths: { count: 16, hashes: expect.any(Array) },
    });
  });

  it("appends one JSONL record per invocation to the configured absolute stream path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bash-tools-invocation-stream-"));
    const streamPath = join(directory, "nested", "invocations.jsonl");
    try {
      const recorder = createProjectCommandInvocationRecorder(
        { appendEntry: vi.fn() },
        { [BASH_TOOLS_INVOCATIONS_PATH]: streamPath },
      );
      const first = buildProjectCommandInvocationRecord(
        input({
          toolCallId: "stream-1",
          parameters: { commandId: "node_test", secret: "private stream output" },
        }),
      );
      const second = buildProjectCommandInvocationRecord(
        input({ toolCallId: "stream-2", lookup: { attempted: true, success: false } }),
      );

      recorder(first);
      recorder(second);

      const serialized = await readFile(streamPath, "utf8");
      const lines = serialized.trimEnd().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines.map((line) => JSON.parse(line))).toEqual([first, second]);
      expect(serialized).not.toContain("private stream output");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not let append failures affect callers", () => {
    const appendEntry = vi.fn(() => {
      throw new Error("persistence unavailable");
    });
    const recorder = createProjectCommandInvocationRecorder({ appendEntry });

    expect(() => recorder(buildProjectCommandInvocationRecord(input()))).not.toThrow();
    expect(appendEntry).toHaveBeenCalledWith(
      PROJECT_COMMAND_INVOCATION_ENTRY_TYPE,
      expect.objectContaining({ toolCallId: "call-1" }),
    );
  });

  it("builds and persists a bounded record through an injected recorder", () => {
    const recorder = vi.fn();

    recordProjectCommandInvocation(recorder, input({ sessionId: "s".repeat(10_000) }));

    expect(recorder).toHaveBeenCalledOnce();
    const [record] = recorder.mock.calls[0] as [
      ReturnType<typeof buildProjectCommandInvocationRecord>,
    ];
    expect(record.sessionId).toHaveLength(256);
    expect(record.parameters).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(record), "utf8")).toBeLessThanOrEqual(
      PROJECT_COMMAND_INVOCATION_MAX_BYTES,
    );
  });

  it("swallows failures from an injected invocation recorder", () => {
    const recorder = vi.fn(() => {
      throw new Error("recorder unavailable");
    });

    expect(() => recordProjectCommandInvocation(recorder, input())).not.toThrow();
    expect(recorder).toHaveBeenCalledOnce();
  });

  it("aggregates cache decisions, repeated requests, outcomes, statuses, and bounded output metrics", () => {
    const records = [
      buildProjectCommandInvocationRecord(
        input({ cacheDecision: "miss", reason: "executed-after-cache-miss" }),
      ),
      buildProjectCommandInvocationRecord(
        input({
          cacheDecision: "hit",
          reused: true,
          reason: "reused-cache-hit",
          resultCategory: "TEST_FAILURE",
          status: "nonzero",
        }),
      ),
      buildProjectCommandInvocationRecord(
        input({
          cacheDecision: "forced",
          forced: true,
          reason: "executed-forced-cache-bypass",
          resultCategory: "TIMEOUT",
          status: "timeout",
        }),
      ),
      buildProjectCommandInvocationRecord(
        input({
          cacheDecision: "ineligible",
          reason: "executed-cache-ineligible",
          resultCategory: "SPAWN_FAILURE",
          status: "spawn-failure",
        }),
      ),
      buildProjectCommandInvocationRecord(
        input({
          cacheDecision: "invalidated",
          reason: "executed-after-cache-invalidation",
          resultCategory: "CANCELLED",
          status: "cancelled",
        }),
      ),
    ];

    expect(summarizeProjectCommandInvocations(records)).toMatchObject({
      summaryFormatVersion: 1,
      sessionId: "session-1",
      invocationCount: 5,
      cacheDecisions: { miss: 1, hit: 1, forced: 1, ineligible: 1, invalidated: 1 },
      repeatedUnchangedRequests: 1,
      resultCategories: {
        PASS: 1,
        TEST_FAILURE: 1,
        TIMEOUT: 1,
        SPAWN_FAILURE: 1,
        CANCELLED: 1,
      },
      processStatuses: {
        success: 1,
        nonzero: 1,
        timeout: 1,
        "spawn-failure": 1,
        cancelled: 1,
      },
      durationMs: 60,
      executionDurationMs: 40,
      outputBytes: { stdout: 617_280, stderr: 100 },
      truncationCounts: { stdout: 5, stderr: 0 },
      measurements: {
        cacheReuse: { before: 0, after: 1 },
        cacheInvalidation: { before: 0, after: 1 },
        truncation: { before: 0, after: 5 },
        repeatedRequests: { before: 0, after: 1 },
      },
      schemaHashes: ["schema-hash"],
    });
  });

  it("normalizes malformed records while adding them to a summary", () => {
    const malformed = {
      ...buildProjectCommandInvocationRecord(input()),
      resultCategory: "not-a-category",
      cacheDecision: "not-a-cache-decision",
      status: "not-a-status",
      durationMs: Number.NaN,
      executionDurationMs: Number.POSITIVE_INFINITY,
      output: {
        stdout: { truncated: true, totalBytes: Number.NaN, totalLines: -1 },
        stderr: { truncated: false, totalBytes: Number.POSITIVE_INFINITY, totalLines: 0 },
      },
      measurements: {
        cacheReuse: { before: Number.NaN, after: -1 },
      },
      schemaHash: 42,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    } as unknown as ReturnType<typeof buildProjectCommandInvocationRecord>;

    const summary = summarizeProjectCommandInvocations([malformed]);
    if (summary === undefined) throw new Error("expected a summary");

    expect(summary.invocationCount).toBe(1);
    expect(summary.cacheDecisions.ineligible).toBe(1);
    expect(summary.resultCategories.IMPLEMENTATION_FAILURE).toBe(1);
    expect(summary.processStatuses).toEqual({
      success: 0,
      nonzero: 0,
      timeout: 0,
      "spawn-failure": 0,
      cancelled: 0,
    });
    expect(summary.durationMs).toBe(0);
    expect(summary.executionDurationMs).toBe(0);
    expect(summary.outputBytes).toEqual({ stdout: 0, stderr: 0 });
    expect(summary.truncationCounts).toEqual({ stdout: 1, stderr: 0 });
    expect(summary.measurements.cacheReuse).toEqual({ before: 0, after: 0 });
    expect(summary.schemaHashes).toEqual([]);
  });

  it("keeps summaries bounded and excludes parameters and output text", () => {
    const records = Array.from({ length: PROJECT_COMMAND_SUMMARY_MAX_SCHEMA_HASHES + 8 }, (_, i) =>
      buildProjectCommandInvocationRecord(
        input({
          schemaHash: `schema-${i}`,
          parameters: { prompt: "secret prompt", path: "private/source.ts" },
          output: {
            stdout: {
              truncated: true,
              totalBytes: Number.MAX_SAFE_INTEGER,
              totalLines: Number.MAX_SAFE_INTEGER,
            },
            stderr: { truncated: true, totalBytes: Number.MAX_SAFE_INTEGER, totalLines: 1 },
          },
        }),
      ),
    );
    const summary = summarizeProjectCommandInvocations(records);
    if (summary === undefined) throw new Error("expected a summary");
    const serialized = JSON.stringify(summary);

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
      PROJECT_COMMAND_SUMMARY_MAX_BYTES,
    );
    expect(summary.schemaHashes.length).toBeLessThanOrEqual(
      PROJECT_COMMAND_SUMMARY_MAX_SCHEMA_HASHES,
    );
    expect(serialized).not.toContain("secret prompt");
    expect(serialized).not.toContain("private/source.ts");
    expect(serialized).not.toContain("complete output");
    expect(summary.outputBytes.stdout).toBe(9_999_999_999);
    expect(summary.outputBytes.stderr).toBe(9_999_999_999);
    expect(summary.durationMs).toBe(480);
  });

  it("saturates summary counts instead of growing with session length", () => {
    const record = buildProjectCommandInvocationRecord(input());
    const summary = summarizeProjectCommandInvocations(
      new Array(PROJECT_COMMAND_SUMMARY_MAX_COUNT + 1).fill(record),
    );
    if (summary === undefined) throw new Error("expected a summary");

    expect(summary.invocationCount).toBe(PROJECT_COMMAND_SUMMARY_MAX_COUNT);
    expect(summary.cacheDecisions.miss).toBe(PROJECT_COMMAND_SUMMARY_MAX_COUNT);
    expect(summary.resultCategories.PASS).toBe(PROJECT_COMMAND_SUMMARY_MAX_COUNT);
    expect(summary.processStatuses.success).toBe(PROJECT_COMMAND_SUMMARY_MAX_COUNT);
    expect(summary.truncationCounts.stdout).toBe(PROJECT_COMMAND_SUMMARY_MAX_COUNT);
  });

  it("keeps the session accumulator isolated and flushes one summary per shutdown", () => {
    const appendEntry = vi.fn();
    const session = createProjectCommandInvocationSessionRecorder({ appendEntry });
    const context = (sessionId: string) => ({
      sessionManager: { getSessionId: () => sessionId },
    });
    const recordA = buildProjectCommandInvocationRecord(input({ sessionId: "session-a" }));
    const recordB = buildProjectCommandInvocationRecord(input({ sessionId: "session-b" }));

    session.onSessionStart({ reason: "startup" }, context("session-a"));
    session.invocationRecorder(recordA);
    session.onSessionShutdown({ reason: "quit" }, context("session-a"));
    session.onSessionShutdown({ reason: "quit" }, context("session-a"));
    session.onSessionStart({ reason: "new" }, context("session-b"));
    session.invocationRecorder(recordB);
    session.onSessionShutdown({ reason: "quit" }, context("session-b"));

    expect(appendEntry).toHaveBeenCalledTimes(4);
    expect(appendEntry).toHaveBeenNthCalledWith(1, PROJECT_COMMAND_INVOCATION_ENTRY_TYPE, recordA);
    expect(appendEntry).toHaveBeenNthCalledWith(
      2,
      PROJECT_COMMAND_SUMMARY_ENTRY_TYPE,
      expect.objectContaining({ sessionId: "session-a", invocationCount: 1 }),
    );
    expect(appendEntry).toHaveBeenNthCalledWith(3, PROJECT_COMMAND_INVOCATION_ENTRY_TYPE, recordB);
    expect(appendEntry).toHaveBeenNthCalledWith(
      4,
      PROJECT_COMMAND_SUMMARY_ENTRY_TYPE,
      expect.objectContaining({ sessionId: "session-b", invocationCount: 1 }),
    );
  });
});
