/* oxlint-disable typescript/no-unsafe-type-assertion */

import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildReadBatchInvocationRecord,
  type ReadBatchInvocationRecord,
  type ReadBatchInvocationReason,
  type ReadBatchInvocationRecorder,
} from "../../src/observability/read-batch-invocation.ts";
import {
  createReadBatchToolForTesting,
  type ReadBatchToolContext,
} from "../../src/tools/filesystem/read-batch-tool.ts";
import { createPolicyTestFixtures } from "../policy/test-fixtures.ts";

const fixtures = createPolicyTestFixtures();

afterEach(async () => {
  vi.useRealTimers();
  await fixtures.cleanup();
});

function context(cwd: string, sessionId?: string): ReadBatchToolContext {
  return {
    cwd,
    mode: "print",
    hasUI: false,
    signal: undefined,
    ui: { select: async () => undefined },
    ...(sessionId === undefined ? {} : { sessionManager: { getSessionId: () => sessionId } }),
  };
}

function recorderCapture(): {
  readonly recorder: ReadBatchInvocationRecorder;
  readonly records: ReadBatchInvocationRecord[];
} {
  const records: ReadBatchInvocationRecord[] = [];
  return {
    recorder: (record) => {
      records.push(record);
    },
    records,
  };
}

async function invocationFixture(): Promise<{ configPath: string; cleanup: () => Promise<void> }> {
  const directory = await fixtures.createDirectory();
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  return { configPath, cleanup: () => fixtures.cleanup() };
}

it("reads bounded ranges in one request and returns per-path errors", async () => {
  const directory = await fixtures.createDirectory();
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src", "one.ts"), "first\nsecond\nthird\n");
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const tool = createReadBatchToolForTesting({ configPath });

  const result = await tool.execute(
    "read-batch",
    {
      paths: [{ path: "src/one.ts", range: { offset: 2, limit: 1 } }, { path: "src/missing.ts" }],
    },
    undefined,
    undefined,
    context(directory),
  );

  expect(result.details.results).toHaveLength(2);
  expect(result.details.results[0]).toMatchObject({
    path: "src/one.ts",
    range: { offset: 2, limit: 1 },
    unchanged: false,
    content: "second",
    output: { truncated: false, totalLines: 4 },
  });
  expect(result.details.results[0]?.ref).toMatch(/^rr_[a-f0-9]{24}$/u);
  expect(result.details.results[1]).toMatchObject({
    path: "src/missing.ts",
    error: { code: "path-resolution-failure" },
  });
});

it("returns unchanged and the prior ref for equivalent normalized reads", async () => {
  const directory = await fixtures.createDirectory();
  await writeFile(join(directory, "read.ts"), "alpha\nbeta\n");
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const tool = createReadBatchToolForTesting({ configPath });
  const absolutePath = join(directory, "read.ts");

  const first = await tool.execute(
    "first",
    { paths: [{ path: "read.ts", range: { offset: 1, limit: 1 } }] },
    undefined,
    undefined,
    context(directory),
  );
  const second = await tool.execute(
    "second",
    { paths: [{ path: absolutePath, range: { offset: 1, limit: 1 } }] },
    undefined,
    undefined,
    context(directory),
  );

  expect(first.details.results[0]).toMatchObject({
    path: "read.ts",
    unchanged: false,
    content: "alpha",
  });
  expect(second.details.results[0]).toEqual({
    path: "read.ts",
    range: { offset: 1, limit: 1 },
    unchanged: true,
    ref: first.details.results[0]?.ref,
  });
});

it("refreshes the reference after the file content changes", async () => {
  const directory = await fixtures.createDirectory();
  const filePath = join(directory, "changed.txt");
  await writeFile(filePath, "before");
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const tool = createReadBatchToolForTesting({ configPath });

  const first = await tool.execute(
    "before-change",
    { paths: [{ path: "changed.txt" }] },
    undefined,
    undefined,
    context(directory),
  );
  await writeFile(filePath, "after");
  const second = await tool.execute(
    "after-change",
    { paths: [{ path: "changed.txt" }] },
    undefined,
    undefined,
    context(directory),
  );

  expect(second.details.results[0]).toMatchObject({
    path: "changed.txt",
    unchanged: false,
    content: "after",
  });
  expect(second.details.results[0]?.ref).not.toBe(first.details.results[0]?.ref);
});

it("keeps a failed path from preventing other paths from being read", async () => {
  const directory = await fixtures.createDirectory();
  await writeFile(join(directory, "ok.txt"), "ok");
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const tool = createReadBatchToolForTesting({ configPath });

  const result = await tool.execute(
    "mixed",
    { paths: [{ path: "missing.txt" }, { path: "ok.txt" }] },
    undefined,
    undefined,
    context(directory),
  );

  expect(result.details.results[0]?.error).toBeDefined();
  expect(result.details.results[1]).toMatchObject({ path: "ok.txt", content: "ok" });
});

describe("read batch invocation records", () => {
  it("records per-item sizes and aggregate result size without paths or content", async () => {
    const { configPath } = await invocationFixture();
    const root = await realpath(dirname(configPath));
    await writeFile(join(root, "src.txt"), "one\ntwo\n");
    const capture = recorderCapture();
    const tool = createReadBatchToolForTesting({
      configPath,
      invocationRecorder: capture.recorder,
    });

    const result = await tool.execute(
      "call-1",
      { paths: [{ path: "src.txt" }, { path: "missing.txt" }] },
      undefined,
      undefined,
      context(root, "session-1"),
    );

    expect(capture.records).toHaveLength(1);
    const record = capture.records[0];
    if (record === undefined) throw new Error("expected one invocation record");
    expect(record).toMatchObject({
      invocationFormatVersion: 1,
      sessionId: "session-1",
      toolCallId: "call-1",
      reason: "completed",
      executed: true,
      scope: "session",
      requestedPaths: 2,
      aggregate: {
        unchangedCount: 0,
        truncatedCount: 0,
        errorCount: 1,
        contentBytes: Buffer.byteLength(result.details.results[0]?.content ?? "", "utf8"),
        resultBytes: Buffer.byteLength(JSON.stringify(result.details), "utf8"),
      },
    });
    expect(record.items).toHaveLength(2);
    expect(record.items[0]).toMatchObject({
      unchanged: false,
      truncated: false,
      totalLines: 3,
      totalBytes: Buffer.byteLength("one\ntwo\n", "utf8"),
      contentBytes: Buffer.byteLength("one\ntwo\n", "utf8"),
    });
    expect(record.items[0]?.pathHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(record.items[1]?.errorCode).toBe("path-resolution-failure");
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("src.txt");
    expect(serialized).not.toContain("one\\ntwo\\n");
    expect(record.items[0]?.ref).toBe(result.details.results[0]?.ref);
  });

  it("counts unchanged repeats and carries the prior refs", async () => {
    const { configPath } = await invocationFixture();
    const root = await realpath(dirname(configPath));
    await writeFile(join(root, "read.ts"), "alpha\n");
    const capture = recorderCapture();
    const tool = createReadBatchToolForTesting({
      configPath,
      invocationRecorder: capture.recorder,
    });

    await tool.execute(
      "first",
      { paths: [{ path: "read.ts" }] },
      undefined,
      undefined,
      context(root, "session-1"),
    );
    await tool.execute(
      "second",
      { paths: [{ path: "read.ts" }] },
      undefined,
      undefined,
      context(root, "session-1"),
    );

    expect(capture.records).toHaveLength(2);
    expect(capture.records[0]?.aggregate.unchangedCount).toBe(0);
    expect(capture.records[1]?.aggregate.unchangedCount).toBe(1);
    expect(capture.records[1]?.aggregate.contentBytes).toBe(0);
    expect(capture.records[1]?.items[0]?.unchanged).toBe(true);
    expect(capture.records[1]?.items[0]?.ref).toBe(capture.records[0]?.items[0]?.ref);
  });

  it("records invalid requests and rethrows without item data", async () => {
    const { configPath } = await invocationFixture();
    const root = await realpath(dirname(configPath));
    const capture = recorderCapture();
    const tool = createReadBatchToolForTesting({
      configPath,
      invocationRecorder: capture.recorder,
    });

    await expect(
      tool.execute("call-1", { paths: [] }, undefined, undefined, context(root, "session-1")),
    ).rejects.toThrow();

    expect(capture.records).toHaveLength(1);
    expect(capture.records[0]).toMatchObject({
      reason: "invalid-request",
      executed: false,
      requestedPaths: 0,
      items: [],
    });
    expect(capture.records[0]?.aggregate).toEqual({
      resultBytes: 0,
      contentBytes: 0,
      totalBytes: 0,
      totalLines: 0,
      unchangedCount: 0,
      truncatedCount: 0,
      errorCount: 0,
    });
  });

  it("does not record when the session id is unavailable", async () => {
    const { configPath } = await invocationFixture();
    const root = await realpath(dirname(configPath));
    await writeFile(join(root, "read.ts"), "alpha\n");
    const capture = recorderCapture();
    const tool = createReadBatchToolForTesting({
      configPath,
      invocationRecorder: capture.recorder,
    });

    await tool.execute(
      "call-1",
      { paths: [{ path: "read.ts" }] },
      undefined,
      undefined,
      context(root),
    );

    expect(capture.records).toHaveLength(0);
  });

  it("normalizes malformed record fields while keeping the bounded shape", () => {
    const malformed = buildReadBatchInvocationRecord({
      sessionId: "session-1",
      toolCallId: "call-1",
      schemaHash: "schema-hash",
      requestedPaths: -3,
      reason: "not-a-reason" as unknown as ReadBatchInvocationReason,
      executed: true,
      durationMs: Number.NaN,
    });

    expect(malformed).toMatchObject({
      invocationFormatVersion: 1,
      reason: "failed",
      requestedPaths: 0,
      durationMs: 0,
      executed: true,
    });
  });

  it("observes repository state and records a readable workspace block", async () => {
    const { configPath } = await invocationFixture();
    const root = await realpath(dirname(configPath));
    await writeFile(join(root, "read.ts"), "alpha\n");
    const capture = recorderCapture();
    const reader = vi.fn(async () => ({
      repositoryIdentity: root,
      head: "3cd6e8f69909c2ad1dfa900961265fc4061fedf7",
      dirtyFilesDigest: "c".repeat(64),
    }));
    const tool = createReadBatchToolForTesting({
      configPath,
      invocationRecorder: capture.recorder,
      repositoryStateReader: reader,
    });

    await tool.execute(
      "call-1",
      { paths: [{ path: "read.ts" }] },
      undefined,
      undefined,
      context(root, "session-1"),
    );

    expect(reader).toHaveBeenCalledOnce();
    expect(capture.records[0]?.repositoryState).toEqual({
      repositoryId: expect.stringMatching(/^[0-9a-f]{64}$/u),
      head: "3cd6e8f69909c2ad1dfa900961265fc4061fedf7",
      dirtyDigest: "c".repeat(64),
      status: "readable",
    });
  });

  it("records a degraded workspace block when state observation fails", async () => {
    const { configPath } = await invocationFixture();
    const root = await realpath(dirname(configPath));
    await writeFile(join(root, "read.ts"), "alpha\n");
    const capture = recorderCapture();
    const reader = vi.fn(async () => undefined);
    const tool = createReadBatchToolForTesting({
      configPath,
      invocationRecorder: capture.recorder,
      repositoryStateReader: reader,
    });

    await tool.execute(
      "call-1",
      { paths: [{ path: "read.ts" }] },
      undefined,
      undefined,
      context(root, "session-1"),
    );

    expect(capture.records[0]?.repositoryState).toEqual({
      repositoryId: expect.stringMatching(/^[0-9a-f]{64}$/u),
      head: null,
      dirtyDigest: null,
      status: "degraded",
    });
  });

  it("still records a degraded workspace block when the reader throws", async () => {
    const { configPath } = await invocationFixture();
    const root = await realpath(dirname(configPath));
    await writeFile(join(root, "read.ts"), "alpha\n");
    const capture = recorderCapture();
    const reader = vi.fn(async () => {
      throw new Error("git unavailable");
    });
    const tool = createReadBatchToolForTesting({
      configPath,
      invocationRecorder: capture.recorder,
      repositoryStateReader: reader,
    });

    await tool.execute(
      "call-1",
      { paths: [{ path: "read.ts" }] },
      undefined,
      undefined,
      context(root, "session-1"),
    );

    expect(capture.records[0]?.repositoryState).toMatchObject({ status: "degraded" });
  });

  it("does not observe repository state when observability is off", async () => {
    const { configPath } = await invocationFixture();
    const root = await realpath(dirname(configPath));
    await writeFile(join(root, "read.ts"), "alpha\n");
    const reader = vi.fn(async () => undefined);
    const tool = createReadBatchToolForTesting({
      configPath,
      repositoryStateReader: reader,
    });

    await tool.execute(
      "call-1",
      { paths: [{ path: "read.ts" }] },
      undefined,
      undefined,
      context(root, "session-1"),
    );

    expect(reader).not.toHaveBeenCalled();
  });

  it("observes repository state without a git executable as degraded", async () => {
    const { configPath } = await invocationFixture();
    const root = await realpath(dirname(configPath));
    await writeFile(join(root, "read.ts"), "alpha\n");
    const capture = recorderCapture();
    const tool = createReadBatchToolForTesting({
      configPath,
      invocationRecorder: capture.recorder,
    });

    await tool.execute(
      "call-1",
      { paths: [{ path: "read.ts" }] },
      undefined,
      undefined,
      context(root, "session-1"),
    );

    expect(capture.records[0]?.repositoryState).toEqual({
      repositoryId: expect.stringMatching(/^[0-9a-f]{64}$/u),
      head: null,
      dirtyDigest: null,
      status: "degraded",
    });
  });
});
