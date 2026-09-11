/* oxlint-disable typescript/no-unsafe-type-assertion */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildGitInvocationRecord,
  createGitInvocationRecorder,
  GIT_INVOCATION_ENTRY_TYPE,
  GIT_INVOCATION_MAX_BYTES,
  recordGitInvocation,
  type GitInvocationReason,
  type GitInvocationRecordInput,
  type GitInvocationToolName,
} from "../../src/observability/git-invocation.ts";
import { BASH_TOOLS_INVOCATIONS_PATH } from "../../src/observability/invocation-stream.ts";

function input(overrides: Partial<GitInvocationRecordInput> = {}): GitInvocationRecordInput {
  return {
    tool: "git_status",
    sessionId: "session-1",
    toolCallId: "call-1",
    schemaHash: "schema-hash",
    requestedPaths: 1,
    reason: "completed",
    durationMs: 12.8,
    unchanged: true,
    resultBytes: 4_321,
    errorCode: undefined,
    ...overrides,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
});

describe("git invocation records", () => {
  it("records identity, timing, result size, and unchanged metadata without revisions or paths", () => {
    const record = buildGitInvocationRecord(input());

    expect(record).toMatchObject({
      invocationFormatVersion: 1,
      tool: "git_status",
      sessionId: "session-1",
      toolCallId: "call-1",
      schemaHash: "schema-hash",
      requestedPaths: 1,
      reason: "completed",
      durationMs: 12,
      unchanged: true,
      aggregate: { resultBytes: 4_321 },
    });
    expect("repositoryState" in record).toBe(false);
    expect("errorCode" in record).toBe(false);
  });

  it("keeps a valid workspace block and drops malformed repository state", () => {
    const valid = buildGitInvocationRecord(
      input({
        repositoryState: {
          repositoryId: "b".repeat(64),
          head: "3cd6e8f69909c2ad1dfa900961265fc4061fedf7",
          dirtyDigest: "c".repeat(64),
          status: "readable",
        },
      }),
    );

    expect(valid.repositoryState).toEqual({
      repositoryId: "b".repeat(64),
      head: "3cd6e8f69909c2ad1dfa900961265fc4061fedf7",
      dirtyDigest: "c".repeat(64),
      status: "readable",
    });

    const malformed = buildGitInvocationRecord(
      input({
        repositoryState: {
          repositoryId: "not-a-hash",
          head: "head",
          dirtyDigest: "digest",
          status: "unexpected",
        } as never,
      }),
    );

    expect(malformed.repositoryState).toBeUndefined();
  });

  it("keeps a degraded workspace block with a real repository id and null derivations", () => {
    const record = buildGitInvocationRecord(
      input({
        repositoryState: {
          repositoryId: "b".repeat(64),
          head: null,
          dirtyDigest: null,
          status: "degraded",
        },
      }),
    );

    expect(record.repositoryState).toEqual({
      repositoryId: "b".repeat(64),
      head: null,
      dirtyDigest: null,
      status: "degraded",
    });
  });

  it("normalizes malformed scalar fields into bounded values", () => {
    const record = buildGitInvocationRecord(
      input({
        tool: "not-a-tool" as unknown as GitInvocationToolName,
        reason: "not-a-reason" as unknown as GitInvocationReason,
        durationMs: Number.NaN,
        requestedPaths: -4,
        resultBytes: Number.MAX_SAFE_INTEGER * 4,
        errorCode: "x".repeat(1_000),
      }),
    );

    expect(record.tool).toBe("git_status");
    expect(record.reason).toBe("failed");
    expect(record.durationMs).toBe(0);
    expect(record.requestedPaths).toBe(0);
    expect(record.aggregate.resultBytes).toBe(9_999_999_999);
    expect(record.errorCode).toHaveLength(128);
  });

  it("bounds oversized identifiers and keeps records within the byte cap", () => {
    const record = buildGitInvocationRecord(
      input({
        sessionId: "s".repeat(10_000),
        toolCallId: "t".repeat(10_000),
        schemaHash: "h".repeat(10_000),
        repositoryState: {
          repositoryId: "b".repeat(64),
          head: "head".padEnd(600, "x"),
          dirtyDigest: "d".repeat(64),
          status: "readable",
        } as never,
      }),
    );

    expect(record.sessionId).toHaveLength(256);
    expect(record.toolCallId).toHaveLength(256);
    expect(record.schemaHash).toHaveLength(256);
    expect(record.repositoryState).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(record), "utf8")).toBeLessThanOrEqual(
      GIT_INVOCATION_MAX_BYTES,
    );
  });

  it("builds a zero aggregate for failures without result data", () => {
    const record = buildGitInvocationRecord(
      input({
        reason: "invalid-request",
        unchanged: false,
        resultBytes: 0,
        errorCode: "invalid-request",
      }),
    );

    expect(record.reason).toBe("invalid-request");
    expect(record.unchanged).toBe(false);
    expect(record.aggregate).toEqual({ resultBytes: 0 });
    expect(record.errorCode).toBe("invalid-request");
  });

  it("swallows failures from an injected recorder", () => {
    const recorder = vi.fn(() => {
      throw new Error("recorder unavailable");
    });

    expect(() => recordGitInvocation(recorder, input())).not.toThrow();
    expect(recorder).toHaveBeenCalledOnce();
    expect(() => recordGitInvocation(undefined, input())).not.toThrow();
  });
});

describe("git invocation recorder", () => {
  it("appends custom entries and JSONL stream records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bash-tools-git-"));
    const streamPath = join(directory, "nested", "invocations.jsonl");
    const appendEntry = vi.fn();
    const recorder = createGitInvocationRecorder(
      { appendEntry },
      { [BASH_TOOLS_INVOCATIONS_PATH]: streamPath },
    );
    const record = buildGitInvocationRecord(input());

    recorder(record);

    expect(appendEntry).toHaveBeenCalledWith(GIT_INVOCATION_ENTRY_TYPE, record);
    const stream = await readFile(streamPath, "utf8");
    expect(stream.trimEnd()).toBe(JSON.stringify(record));
    await rm(directory, { recursive: true, force: true });
  });

  it("keeps appending custom entries when the stream path is not absolute", async () => {
    const appendEntry = vi.fn();
    const recorder = createGitInvocationRecorder(
      { appendEntry },
      { [BASH_TOOLS_INVOCATIONS_PATH]: "relative/stream.jsonl" },
    );
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

    recorder(buildGitInvocationRecord(input()));

    expect(appendEntry).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledOnce();
  });

  it("ignores unset stream configuration", async () => {
    const appendEntry = vi.fn();
    const recorder = createGitInvocationRecorder({ appendEntry }, {});

    recorder(buildGitInvocationRecord(input()));

    expect(appendEntry).toHaveBeenCalledOnce();
  });
});
