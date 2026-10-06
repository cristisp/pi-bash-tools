/* oxlint-disable typescript/no-unsafe-type-assertion */

import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthorizationOutcomeRecord } from "../../src/observability/authorization-outcome.ts";
import {
  buildReadBatchInvocationRecord,
  type ReadBatchInvocationRecord,
  type ReadBatchInvocationReason,
  type ReadBatchInvocationRecorder,
} from "../../src/observability/read-batch-invocation.ts";
import {
  createReadBatchToolForTesting,
  readBatchDetailsSchema,
  type ReadBatchDetails,
  type ReadBatchInput,
  type ReadBatchToolContext,
} from "../../src/tools/filesystem/read-batch-tool.ts";
import type {
  ReadEvidenceRecord,
  ReadEvidenceStore,
} from "../../src/tools/filesystem/read-evidence-store.ts";
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

function storeDouble(published: boolean): ReadEvidenceStore {
  return {
    getByRef: () => undefined,
    lookupOutcome: () => "missing",
    publish: () => published,
    clear: () => undefined,
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

it("returns schema-conforming structuredContent for every result mode", async () => {
  const directory = await fixtures.createDirectory();
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src", "one.ts"), "first\nsecond\nthird\n");
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const tool = createReadBatchToolForTesting({ configPath });
  expect(tool.outputSchema).toBe(readBatchDetailsSchema);

  const assertConforms = (response: AgentToolResult<ReadBatchDetails>): void => {
    expect(response.structuredContent).toEqual(response.details);
    expect(Check(readBatchDetailsSchema, response.structuredContent)).toBe(true);
    expect(response.content).toEqual([{ type: "text", text: JSON.stringify(response.details) }]);
  };

  const first = await tool.execute(
    "first",
    {
      paths: [{ path: "src/one.ts", range: { offset: 2, limit: 1 } }, { path: "src/missing.ts" }],
    },
    undefined,
    undefined,
    context(directory),
  );
  assertConforms(first);

  const repeat = await tool.execute(
    "repeat",
    { paths: [{ path: "src/one.ts", range: { offset: 2, limit: 1 } }] },
    undefined,
    undefined,
    context(directory),
  );
  expect(repeat.details.results[0]).toMatchObject({ unchanged: true });
  assertConforms(repeat);

  const big = `${"x".repeat(55 * 1024)}\n`;
  const names = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"];
  await Promise.all(names.map((name) => writeFile(join(directory, name), big)));
  const aggregate = await tool.execute(
    "aggregate",
    { paths: names.map((path) => ({ path })) },
    undefined,
    undefined,
    context(directory),
  );
  expect(aggregate.details.continuation).toMatchObject({ nextIndex: 4, totalPaths: 5 });
  assertConforms(aggregate);
});

it("rejects duplicate and overlapping ranges in one request", async () => {
  const directory = await fixtures.createDirectory();
  await writeFile(join(directory, "dup.txt"), "one\ntwo\n");
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const tool = createReadBatchToolForTesting({ configPath });

  await expect(
    tool.execute(
      "duplicate",
      {
        paths: [
          { path: "dup.txt", range: { offset: 1, limit: 1 } },
          { path: "dup.txt", range: { offset: 1, limit: 2 } },
        ],
      },
      undefined,
      undefined,
      context(directory),
    ),
  ).rejects.toThrow(/duplicate or overlapping range for path "dup\.txt"/u);

  await expect(
    tool.execute(
      "full-plus-range",
      { paths: [{ path: "dup.txt" }, { path: "dup.txt", range: { offset: 2 } }] },
      undefined,
      undefined,
      context(directory),
    ),
  ).rejects.toThrow(/duplicate or overlapping range for path "dup\.txt"/u);
});

it("allows disjoint ranges for the same path in one request", async () => {
  const directory = await fixtures.createDirectory();
  await writeFile(join(directory, "slices.txt"), "one\ntwo\nthree\n");
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const tool = createReadBatchToolForTesting({ configPath });

  const result = await tool.execute(
    "disjoint",
    {
      paths: [
        { path: "slices.txt", range: { offset: 1, limit: 1 } },
        { path: "slices.txt", range: { offset: 2, limit: 1 } },
      ],
    },
    undefined,
    undefined,
    context(directory),
  );

  expect(result.details.results[0]).toMatchObject({ path: "slices.txt", content: "one" });
  expect(result.details.results[1]).toMatchObject({ path: "slices.txt", content: "two" });
  expect(result.details.continuation).toBeUndefined();
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

  const expectedHash = createHash("sha256")
    .update(await readFile(join(directory, "read.ts")))
    .digest("hex");
  expect(first.details.results[0]).toMatchObject({
    path: "read.ts",
    unchanged: false,
    content: "alpha",
    contentHash: expectedHash,
  });
  expect(second.details.results[0]).toEqual({
    path: "read.ts",
    range: { offset: 1, limit: 1 },
    unchanged: true,
    ref: first.details.results[0]?.ref,
    contentHash: expectedHash,
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

it("caps the aggregate returned content and reports aggregate-limit skips", async () => {
  const directory = await fixtures.createDirectory();
  const names = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "f.txt"];
  await Promise.all(names.map((name) => writeFile(join(directory, name), "x".repeat(70 * 1024))));
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const capture = recorderCapture();
  const tool = createReadBatchToolForTesting({
    configPath,
    invocationRecorder: capture.recorder,
  });

  const result = await tool.execute(
    "aggregate",
    { paths: names.map((path) => ({ path })) },
    undefined,
    undefined,
    context(directory, "session-1"),
  );

  expect(result.details.results).toHaveLength(6);
  expect(result.details.results.map((item) => item.path)).toEqual(names);
  const returned = result.details.results.slice(0, 4);
  const skipped = result.details.results.slice(4);
  expect(returned.every((item) => item.content !== undefined && item.error === undefined)).toBe(
    true,
  );
  expect(
    skipped.every(
      (item) =>
        item.content === undefined &&
        item.error?.code === "aggregate-limit" &&
        item.error?.category === "INVALID_REQUEST" &&
        item.error?.retryable === false &&
        item.error?.executed === false,
    ),
  ).toBe(true);
  const aggregateContent = result.details.results.reduce(
    (sum, item) => sum + Buffer.byteLength(item.content ?? "", "utf8"),
    0,
  );
  expect(aggregateContent).toBeLessThanOrEqual(256 * 1024);
  expect(result.details.continuation).toEqual({ nextIndex: 4, totalPaths: 6 });
  expect(capture.records[0]?.aggregate.errorCount).toBe(2);
  expect(capture.records[0]?.items[5]?.errorCode).toBe("aggregate-limit");
});

it("bounds invalid-UTF-8 aggregate content to the documented 256 KiB aggregate cap", async () => {
  const directory = await fixtures.createDirectory();
  const names = ["ff-a.bin", "ff-b.bin", "ff-c.bin", "ff-d.bin", "ff-e.bin", "ff-f.bin"];
  const raw = Buffer.alloc(70 * 1024, 0xff);
  await Promise.all(names.map((name) => writeFile(join(directory, name), raw)));
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const capture = recorderCapture();
  const tool = createReadBatchToolForTesting({
    configPath,
    invocationRecorder: capture.recorder,
  });

  const result = await tool.execute(
    "invalid-utf8-aggregate",
    { paths: names.map((path) => ({ path })) },
    undefined,
    undefined,
    context(directory, "session-1"),
  );

  expect(result.details.results).toHaveLength(6);
  expect(result.details.results.map((item) => item.path)).toEqual(names);
  const returned = result.details.results.slice(0, 4);
  const skipped = result.details.results.slice(4);
  expect(returned.every((item) => item.content !== undefined && item.error === undefined)).toBe(
    true,
  );
  expect(returned.every((item) => item.output?.truncated === true)).toBe(true);
  expect(
    skipped.every(
      (item) =>
        item.content === undefined &&
        item.error?.code === "aggregate-limit" &&
        item.error?.category === "INVALID_REQUEST" &&
        item.error?.retryable === false &&
        item.error?.executed === false,
    ),
  ).toBe(true);
  const aggregateContent = result.details.results.reduce(
    (sum, item) => sum + Buffer.byteLength(item.content ?? "", "utf8"),
    0,
  );
  expect(aggregateContent).toBeLessThanOrEqual(256 * 1024);
  expect(result.details.continuation).toEqual({ nextIndex: 4, totalPaths: 6 });
  expect(capture.records[0]?.aggregate.errorCount).toBe(2);
  expect(capture.records[0]?.items[5]?.errorCode).toBe("aggregate-limit");
});

it("supports a follow-up request for the remaining paths after aggregate truncation", async () => {
  const directory = await fixtures.createDirectory();
  const names = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "f.txt"];
  await Promise.all(names.map((name) => writeFile(join(directory, name), "x".repeat(70 * 1024))));
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const tool = createReadBatchToolForTesting({ configPath });

  const truncated = await tool.execute(
    "truncated",
    { paths: names.map((path) => ({ path })) },
    undefined,
    undefined,
    context(directory),
  );
  const continuation = truncated.details.continuation;
  expect(continuation).toEqual({ nextIndex: 4, totalPaths: 6 });
  const remaining = names.slice(continuation?.nextIndex ?? names.length);
  const followUp = await tool.execute(
    "follow-up",
    { paths: remaining.map((path) => ({ path })) },
    undefined,
    undefined,
    context(directory),
  );

  expect(followUp.details.results[0]).toMatchObject({
    path: "e.txt",
    content: expect.any(String),
  });
  expect(followUp.details.continuation).toBeUndefined();
});

it("returns stable content hashes for fresh and unchanged observations", async () => {
  const directory = await fixtures.createDirectory();
  const filePath = join(directory, "hashed.txt");
  await writeFile(filePath, "alpha\nbeta\n");
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const tool = createReadBatchToolForTesting({ configPath });
  const expectedHash = createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");

  const first = await tool.execute(
    "first",
    { paths: [{ path: "hashed.txt" }] },
    undefined,
    undefined,
    context(directory),
  );
  const second = await tool.execute(
    "second",
    { paths: [{ path: "hashed.txt" }] },
    undefined,
    undefined,
    context(directory),
  );

  expect(first.details.results[0]).toMatchObject({
    path: "hashed.txt",
    unchanged: false,
    content: "alpha\nbeta\n",
    output: { truncated: false, totalBytes: 11, totalLines: 3 },
    contentHash: expectedHash,
  });
  expect(second.details.results[0]).toEqual({
    path: "hashed.txt",
    unchanged: true,
    ref: first.details.results[0]?.ref,
    contentHash: expectedHash,
  });
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

  it("records orchestration attribution and a failed publication block", async () => {
    const { configPath } = await invocationFixture();
    const root = await realpath(dirname(configPath));
    const capture = recorderCapture();
    const tool = createReadBatchToolForTesting({
      configPath,
      invocationRecorder: capture.recorder,
    });
    vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
    vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
    vi.stubEnv("PI_ORCHESTRATION_ROLE", "worker");
    vi.stubEnv("PI_DELEGATION_ID", "delegation-1");
    try {
      await tool.execute(
        "call-1",
        { paths: [{ path: "missing.txt" }], publish: { flowId: "flow-a" } },
        undefined,
        undefined,
        context(root, "session-1"),
      );

      expect(capture.records).toHaveLength(1);
      expect(capture.records[0]).toMatchObject({
        role: "worker",
        delegationId: "delegation-1",
        scope: "flow",
        flowId: "flow-a",
        publication: {
          scope: "flow",
          flowId: "flow-a",
          published: false,
          error: "Published read evidence requires a fresh read of every requested path.",
        },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("records a successful publication outcome", async () => {
    const { configPath } = await invocationFixture();
    const root = await realpath(dirname(configPath));
    await writeFile(join(root, "read.ts"), "alpha\n");
    const capture = recorderCapture();
    const tool = createReadBatchToolForTesting({
      configPath,
      invocationRecorder: capture.recorder,
      readEvidenceStore: storeDouble(true),
    });
    vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
    vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
    vi.stubEnv("PI_ORCHESTRATION_ROLE", "worker");
    vi.stubEnv("PI_DELEGATION_ID", "delegation-1");
    try {
      await tool.execute(
        "call-1",
        { paths: [{ path: "read.ts" }], publish: { flowId: "flow-a" } },
        undefined,
        undefined,
        context(root, "session-1"),
      );

      expect(capture.records[0]).toMatchObject({
        role: "worker",
        delegationId: "delegation-1",
        scope: "flow",
        flowId: "flow-a",
        publication: { scope: "flow", flowId: "flow-a", published: true },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("records a store-denied publication outcome", async () => {
    const { configPath } = await invocationFixture();
    const root = await realpath(dirname(configPath));
    await writeFile(join(root, "read.ts"), "alpha\n");
    const capture = recorderCapture();
    const tool = createReadBatchToolForTesting({
      configPath,
      invocationRecorder: capture.recorder,
      readEvidenceStore: storeDouble(false),
    });
    vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
    vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
    try {
      await tool.execute(
        "call-1",
        { paths: [{ path: "read.ts" }], publish: { flowId: "flow-a" } },
        undefined,
        undefined,
        context(root, "session-1"),
      );

      expect(capture.records[0]).toMatchObject({
        publication: {
          scope: "flow",
          flowId: "flow-a",
          published: false,
          error: "Read evidence was not published to the requested flow.",
        },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("omits orchestration attribution and publication when not orchestrated", async () => {
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

    expect(Object.hasOwn(capture.records[0] ?? {}, "role")).toBe(false);
    expect(Object.hasOwn(capture.records[0] ?? {}, "delegationId")).toBe(false);
    expect(Object.hasOwn(capture.records[0] ?? {}, "publication")).toBe(false);
  });

  it("records attribution on a lookup invocation without a publication block", async () => {
    const { configPath } = await invocationFixture();
    const root = await realpath(dirname(configPath));
    const capture = recorderCapture();
    const tool = createReadBatchToolForTesting({
      configPath,
      invocationRecorder: capture.recorder,
    });
    vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
    vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
    vi.stubEnv("PI_ORCHESTRATION_ROLE", "reviewer");
    try {
      await expect(
        tool.execute(
          "call-1",
          { ref: "rr_000000000000000000000000" },
          undefined,
          undefined,
          context(root, "session-1"),
        ),
      ).rejects.toThrow(/not found/u);

      expect(capture.records[0]).toMatchObject({ role: "reviewer" });
      expect(capture.records[0]?.lookup?.attempted).toBe(true);
      for (const record of capture.records) {
        expect(Object.hasOwn(record, "publication")).toBe(false);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("read batch authorization attribution", () => {
  function authorizationCapture(): {
    readonly recorder: (record: AuthorizationOutcomeRecord) => void;
    readonly records: AuthorizationOutcomeRecord[];
  } {
    const records: AuthorizationOutcomeRecord[] = [];
    return { recorder: (record) => records.push(record), records };
  }

  it("attributes a filesystem authorization to the effective flow scope", async () => {
    const { configPath } = await invocationFixture();
    const root = await realpath(dirname(configPath));
    await writeFile(join(root, "read.ts"), "alpha\n");
    const capture = authorizationCapture();
    const tool = createReadBatchToolForTesting({
      configPath,
      authorizationOutcomeRecorder: capture.recorder,
    });
    vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
    vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
    vi.stubEnv("PI_ORCHESTRATION_ROLE", "reviewer");
    vi.stubEnv("PI_DELEGATION_ID", "delegation-1");
    try {
      await tool.execute(
        "call-1",
        { paths: [{ path: "read.ts" }] },
        undefined,
        undefined,
        context(root, "session-1"),
      );

      expect(capture.records.length).toBeGreaterThan(0);
      expect(capture.records[0]).toMatchObject({
        surface: "filesystem",
        commandId: "read_batch",
        outcome: "authorized",
        mode: "print",
        flowId: "flow-a",
        role: "reviewer",
        delegationId: "delegation-1",
        decisionSource: "allow-project",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("omits the flow identity from filesystem authorization records for session scope", async () => {
    const { configPath } = await invocationFixture();
    const root = await realpath(dirname(configPath));
    await writeFile(join(root, "read.ts"), "alpha\n");
    const capture = authorizationCapture();
    const tool = createReadBatchToolForTesting({
      configPath,
      authorizationOutcomeRecorder: capture.recorder,
    });
    vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
    try {
      await tool.execute(
        "call-1",
        { paths: [{ path: "read.ts" }] },
        undefined,
        undefined,
        context(root, "session-1"),
      );

      expect(capture.records.length).toBeGreaterThan(0);
      expect(capture.records[0]).toMatchObject({
        surface: "filesystem",
        mode: "print",
        decisionSource: "allow-project",
      });
      for (const record of capture.records) {
        expect(Object.hasOwn(record, "flowId")).toBe(false);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

it("coerces null placeholders to omitted fields and reports the coercions", async () => {
  const directory = await fixtures.createDirectory();
  await writeFile(join(directory, "one.ts"), "one\n");
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const tool = createReadBatchToolForTesting({ configPath });

  const result = await tool.execute(
    "read-null",
    { paths: [{ path: "one.ts" }], ref: null, flowId: null, covers: null, publish: null },
    undefined,
    undefined,
    context(directory),
  );
  expect(result.details.results[0]).toMatchObject({ path: "one.ts", unchanged: false });
  expect(result.details.coercions).toEqual([
    "ref:null-to-absent",
    "flowId:null-to-absent",
    "covers:null-to-absent",
    "publish:null-to-absent",
  ]);

  const ref = result.details.results[0]?.ref;
  expect(ref).toMatch(/^rr_[a-f0-9]{24}$/u);
  await expect(
    tool.execute(
      "read-null-lookup",
      { ref, flowId: null, covers: null },
      undefined,
      undefined,
      context(directory),
    ),
  ).rejects.toThrow(/not found in the process-local root-session store/u);
});

it("keeps null placeholders fail-closed for read_batch", async () => {
  const directory = await fixtures.createDirectory();
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const tool = createReadBatchToolForTesting({ configPath });

  await expect(
    tool.execute("bad-ref", { ref: "junk-string" }, undefined, undefined, context(directory)),
  ).rejects.toThrow(/ref must be a read_batch evidence reference/u);
  await expect(
    tool.execute(
      "future-null",
      { futureOption: null, paths: [{ path: "one.ts" }] } as unknown as ReadBatchInput,
      undefined,
      undefined,
      context(directory),
    ),
  ).rejects.toThrow(/unsupported request field "futureOption"/u);
  await expect(
    tool.execute("empty-ref", { ref: null, paths: [] }, undefined, undefined, context(directory)),
  ).rejects.toThrow(/paths must contain at least one entry/u);
});

describe("records one invocation per terminal path", () => {
  function storeBackedDouble(): ReadEvidenceStore {
    const records = new Map<string, ReadEvidenceRecord>();
    return {
      getByRef: (ref) => records.get(ref),
      lookupOutcome: (ref) => (records.has(ref) ? "found" : "missing"),
      publish: (record) => {
        records.set(record.ref, record);
        return true;
      },
      clear: () => records.clear(),
    };
  }

  it("records exactly one completed lookup record for a lookup hit", async () => {
    const { configPath } = await invocationFixture();
    const root = await realpath(dirname(configPath));
    await writeFile(join(root, "read.ts"), "alpha\n");
    const capture = recorderCapture();
    const tool = createReadBatchToolForTesting({
      configPath,
      invocationRecorder: capture.recorder,
      readEvidenceStore: storeBackedDouble(),
    });
    vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
    vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
    try {
      const published = await tool.execute(
        "publish",
        { paths: [{ path: "read.ts" }], publish: { flowId: "flow-a" } },
        undefined,
        undefined,
        context(root, "session-1"),
      );
      const ref = published.details.publish?.ref;
      expect(ref).toMatch(/^rr_[a-f0-9]{24}$/u);

      const lookup = await tool.execute(
        "lookup",
        { ref },
        undefined,
        undefined,
        context(root, "session-1"),
      );

      expect(lookup.details.lookup?.executed).toBe(false);
      expect(lookup.structuredContent).toEqual(lookup.details);
      expect(Check(readBatchDetailsSchema, lookup.structuredContent)).toBe(true);
      expect(capture.records).toHaveLength(2);
      expect(capture.records[1]).toMatchObject({
        reason: "completed",
        executed: false,
        requestedPaths: 0,
        lookup: { attempted: true, success: true, outcome: "success" },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("records exactly one completed not-found record for a lookup miss", async () => {
    const { configPath } = await invocationFixture();
    const root = await realpath(dirname(configPath));
    const capture = recorderCapture();
    const tool = createReadBatchToolForTesting({
      configPath,
      invocationRecorder: capture.recorder,
      readEvidenceStore: storeDouble(false),
    });

    await expect(
      tool.execute(
        "call-1",
        { ref: "rr_000000000000000000000000" },
        undefined,
        undefined,
        context(root, "session-1"),
      ),
    ).rejects.toThrow(/not found/u);

    expect(capture.records).toHaveLength(1);
    expect(capture.records[0]).toMatchObject({
      reason: "completed",
      executed: false,
      requestedPaths: 0,
      lookup: { attempted: true, success: false, failure: "not-found", outcome: "not-found" },
    });
  });

  it("records exactly one failed record when the store lookup throws", async () => {
    const { configPath } = await invocationFixture();
    const root = await realpath(dirname(configPath));
    const capture = recorderCapture();
    const failingStore: ReadEvidenceStore = {
      getByRef: () => {
        throw new Error("store unavailable");
      },
      lookupOutcome: () => "missing",
      publish: () => false,
      clear: () => undefined,
    };
    const tool = createReadBatchToolForTesting({
      configPath,
      invocationRecorder: capture.recorder,
      readEvidenceStore: failingStore,
    });

    await expect(
      tool.execute(
        "call-1",
        { ref: "rr_000000000000000000000000" },
        undefined,
        undefined,
        context(root, "session-1"),
      ),
    ).rejects.toThrow(/store unavailable/u);

    expect(capture.records).toHaveLength(1);
    expect(capture.records[0]).toMatchObject({
      reason: "failed",
      executed: false,
      lookup: { attempted: true, success: false, failure: "lookup-failure" },
    });
  });

  it("records exactly one completed record for a normal batch read", async () => {
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

    expect(capture.records).toHaveLength(1);
    expect(capture.records[0]).toMatchObject({ reason: "completed", executed: true });
  });

  it("records exactly one invalid-request record for invalid params", async () => {
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
    expect(capture.records[0]).toMatchObject({ reason: "invalid-request", executed: false });
  });

  it("records exactly one cancelled record when the signal aborts before work", async () => {
    const { configPath } = await invocationFixture();
    const root = await realpath(dirname(configPath));
    await writeFile(join(root, "read.ts"), "alpha\n");
    const capture = recorderCapture();
    const tool = createReadBatchToolForTesting({
      configPath,
      invocationRecorder: capture.recorder,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      tool.execute(
        "call-1",
        { paths: [{ path: "read.ts" }] },
        controller.signal,
        undefined,
        context(root, "session-1"),
      ),
    ).rejects.toMatchObject({ contract: { code: "cancelled", category: "CANCELLED" } });

    expect(capture.records).toHaveLength(1);
    expect(capture.records[0]).toMatchObject({ reason: "cancelled", executed: false });
  });
});
