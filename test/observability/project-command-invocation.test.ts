import { describe, expect, it, vi } from "vitest";
import {
  buildProjectCommandInvocationRecord,
  createProjectCommandInvocationRecorder,
  createProjectCommandInvocationSessionRecorder,
  PROJECT_COMMAND_INVOCATION_ENTRY_TYPE,
  PROJECT_COMMAND_INVOCATION_MAX_BYTES,
  PROJECT_COMMAND_SUMMARY_ENTRY_TYPE,
  PROJECT_COMMAND_SUMMARY_MAX_BYTES,
  PROJECT_COMMAND_SUMMARY_MAX_COUNT,
  PROJECT_COMMAND_SUMMARY_MAX_SCHEMA_HASHES,
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
    commandId: "node_e2e",
    parameters: {
      commandId: "node_e2e",
      paths: ["private/source-file.ts"],
      grep: "private test title",
      projects: ["private-project"],
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
      commandId: "node_e2e",
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

  it("hashes sensitive arguments and bounds the complete persisted shape", () => {
    const record = buildProjectCommandInvocationRecord(
      input({
        sessionId: "s".repeat(10_000),
        toolCallId: "t".repeat(10_000),
        parameters: {
          commandId: "node_e2e",
          paths: Array.from({ length: 100 }, (_, index) => `private-${index}.ts`),
          grep: "secret-title".repeat(10_000),
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
      commandId: "node_e2e",
      paths: { count: 16, hashes: expect.any(Array) },
      grep: { hash: expect.any(String) },
    });
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
      schemaHashes: ["schema-hash"],
    });
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
