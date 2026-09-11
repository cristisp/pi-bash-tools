/* oxlint-disable typescript/no-unsafe-type-assertion */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BASH_TOOLS_INVOCATIONS_PATH } from "../../src/observability/invocation-stream.ts";
import {
  buildReadBatchInvocationRecord,
  createReadBatchInvocationRecorder,
  READ_BATCH_INVOCATION_ENTRY_TYPE,
  READ_BATCH_INVOCATION_MAX_BYTES,
  READ_BATCH_INVOCATION_MAX_ITEMS,
  recordReadBatchInvocation,
  type ReadBatchInvocationItem,
  type ReadBatchInvocationReason,
  type ReadBatchInvocationRecordInput,
} from "../../src/observability/read-batch-invocation.ts";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function item(overrides: Partial<ReadBatchInvocationItem> = {}): ReadBatchInvocationItem {
  return {
    pathHash: "a".repeat(64),
    pathLength: 12,
    range: { offset: 2, limit: 10 },
    unchanged: false,
    truncated: true,
    totalBytes: 1_234,
    totalLines: 56,
    contentBytes: 100,
    ref: "rr_0123456789abcdef01234567",
    errorCode: undefined,
    ...overrides,
  };
}

function input(
  overrides: Partial<ReadBatchInvocationRecordInput> = {},
): ReadBatchInvocationRecordInput {
  return {
    sessionId: "session-1",
    toolCallId: "call-1",
    schemaHash: "schema-hash",
    requestedPaths: 3,
    reason: "completed",
    executed: true,
    durationMs: 12.8,
    items: [item(), item({ unchanged: true, truncated: false, contentBytes: 0, ref: undefined })],
    aggregate: {
      resultBytes: 4_321,
      contentBytes: 100,
      totalBytes: 2_468,
      totalLines: 112,
      unchangedCount: 1,
      truncatedCount: 1,
      errorCount: 0,
    },
    scope: "session",
    ...overrides,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
});

describe("read batch invocation records", () => {
  it("records identity, timing, per-item sizes, and aggregate metrics without paths or content", () => {
    const record = buildReadBatchInvocationRecord(input());

    expect(record).toMatchObject({
      invocationFormatVersion: 1,
      sessionId: "session-1",
      toolCallId: "call-1",
      schemaHash: "schema-hash",
      requestedPaths: 3,
      reason: "completed",
      executed: true,
      durationMs: 12,
      scope: "session",
      aggregate: {
        resultBytes: 4_321,
        contentBytes: 100,
        totalBytes: 2_468,
        totalLines: 112,
        unchangedCount: 1,
        truncatedCount: 1,
        errorCount: 0,
      },
    });
    expect(record.items).toHaveLength(2);
    expect(record.items[0]?.pathHash).toMatch(SHA256_PATTERN);
    expect(JSON.stringify(record)).not.toContain("src/example.ts");
    expect(JSON.stringify(record)).not.toContain("file content");
  });

  it("includes flow scope metadata when publishing to a flow", () => {
    const record = buildReadBatchInvocationRecord(input({ scope: "flow", flowId: "flow-9" }));

    expect(record.scope).toBe("flow");
    expect(record.flowId).toBe("flow-9");
  });

  it("keeps a valid workspace block and drops malformed repository state", () => {
    const valid = buildReadBatchInvocationRecord(
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

    const malformed = buildReadBatchInvocationRecord(
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

  it("normalizes malformed item fields into bounded values", () => {
    const record = buildReadBatchInvocationRecord(
      input({
        reason: "not-a-reason" as unknown as ReadBatchInvocationReason,
        durationMs: Number.NaN,
        requestedPaths: -4,
        items: [
          item({
            pathHash: "not-hex",
            pathLength: Number.POSITIVE_INFINITY,
            totalBytes: Number.NaN,
            totalLines: -1,
            contentBytes: Number.MAX_SAFE_INTEGER * 4,
            ref: "x".repeat(1_000),
            errorCode: "y".repeat(1_000),
          }),
          "garbage" as unknown as ReadBatchInvocationItem,
        ],
      }),
    );

    expect(record.reason).toBe("failed");
    expect(record.durationMs).toBe(0);
    expect(record.requestedPaths).toBe(0);
    expect(record.items).toHaveLength(1);
    expect(record.items[0]).toMatchObject({
      pathHash: "not-hex",
      pathLength: 0,
      unchanged: false,
      truncated: true,
      totalBytes: 0,
      totalLines: 0,
    });
    expect(record.items[0]?.contentBytes).toBe(9_999_999_999);
    expect(record.items[0]?.ref).toHaveLength(256);
    expect(record.items[0]?.errorCode).toHaveLength(128);
  });

  it("caps per-item entries and trims items to keep records bounded", () => {
    const manyItems = Array.from({ length: READ_BATCH_INVOCATION_MAX_ITEMS + 8 }, () => item());
    const capped = buildReadBatchInvocationRecord(input({ items: manyItems }));

    expect(capped.items.length).toBeLessThanOrEqual(READ_BATCH_INVOCATION_MAX_ITEMS);
    expect(capped.items.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(capped), "utf8")).toBeLessThanOrEqual(
      READ_BATCH_INVOCATION_MAX_BYTES,
    );

    const oversized = item({ ref: "z".repeat(512) });
    const minimal = buildReadBatchInvocationRecord(
      input({
        sessionId: "s".repeat(10_000),
        items: Array.from({ length: READ_BATCH_INVOCATION_MAX_ITEMS }, () => oversized),
      }),
    );

    expect(minimal.items.length).toBeLessThan(READ_BATCH_INVOCATION_MAX_ITEMS);
    expect(Buffer.byteLength(JSON.stringify(minimal), "utf8")).toBeLessThanOrEqual(
      READ_BATCH_INVOCATION_MAX_BYTES,
    );
    expect(minimal.aggregate.resultBytes).toBe(4_321);
  });

  it("keeps every item when the record fits within the byte cap", () => {
    const record = buildReadBatchInvocationRecord(
      input({ items: Array.from({ length: 8 }, () => item()) }),
    );

    expect(record.items).toHaveLength(8);
  });

  it("builds a zero aggregate for failures without item data", () => {
    const record = buildReadBatchInvocationRecord(
      input({ reason: "invalid-request", executed: false, items: undefined, aggregate: undefined }),
    );

    expect(record.executed).toBe(false);
    expect(record.items).toEqual([]);
    expect(record.aggregate).toEqual({
      resultBytes: 0,
      contentBytes: 0,
      totalBytes: 0,
      totalLines: 0,
      unchangedCount: 0,
      truncatedCount: 0,
      errorCount: 0,
    });
  });

  it("swallows failures from an injected recorder", () => {
    const recorder = vi.fn(() => {
      throw new Error("recorder unavailable");
    });

    expect(() => recordReadBatchInvocation(recorder, input())).not.toThrow();
    expect(recorder).toHaveBeenCalledOnce();
    expect(() => recordReadBatchInvocation(undefined, input())).not.toThrow();
  });
});

describe("read batch invocation recorder", () => {
  it("appends custom entries and JSONL stream records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bash-tools-read-batch-"));
    const streamPath = join(directory, "nested", "invocations.jsonl");
    const appendEntry = vi.fn();
    const recorder = createReadBatchInvocationRecorder(
      { appendEntry },
      { [BASH_TOOLS_INVOCATIONS_PATH]: streamPath },
    );
    const record = buildReadBatchInvocationRecord(input());

    recorder(record);

    expect(appendEntry).toHaveBeenCalledWith(READ_BATCH_INVOCATION_ENTRY_TYPE, record);
    const stream = await readFile(streamPath, "utf8");
    expect(stream.trimEnd()).toBe(JSON.stringify(record));
    await rm(directory, { recursive: true, force: true });
  });

  it("keeps appending custom entries when the stream path is not absolute", async () => {
    const appendEntry = vi.fn();
    const recorder = createReadBatchInvocationRecorder(
      { appendEntry },
      { [BASH_TOOLS_INVOCATIONS_PATH]: "relative/stream.jsonl" },
    );
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

    recorder(buildReadBatchInvocationRecord(input()));

    expect(appendEntry).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledOnce();
  });

  it("ignores unset stream configuration", async () => {
    const appendEntry = vi.fn();
    const recorder = createReadBatchInvocationRecorder({ appendEntry }, {});

    recorder(buildReadBatchInvocationRecord(input()));

    expect(appendEntry).toHaveBeenCalledOnce();
  });
});
