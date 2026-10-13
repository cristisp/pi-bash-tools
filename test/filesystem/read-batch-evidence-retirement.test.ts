/* oxlint-disable typescript/no-unsafe-type-assertion */

import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";

import {
  buildReadBatchInvocationRecord,
  type ReadBatchInvocationRecordInput,
} from "../../src/observability/read-batch-invocation.ts";
import {
  createReadBatchToolForTesting,
  readBatchDetailsSchema,
  type ReadBatchInput,
  type ReadBatchToolContext,
} from "../../src/tools/filesystem/read-batch-tool.ts";
import { createPolicyTestFixtures } from "../policy/test-fixtures.ts";

const fixtures = createPolicyTestFixtures();

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

async function setupDirectory(): Promise<{ directory: string; configPath: string }> {
  const directory = await fixtures.createDirectory();
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src", "one.ts"), "one\ntwo\n");
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  return { directory, configPath };
}

describe("read_batch evidence retirement", () => {
  it("rejects the retired lookup request shape with invalid-request", async () => {
    const { directory, configPath } = await setupDirectory();
    const tool = createReadBatchToolForTesting({ configPath });

    await expect(
      tool.execute(
        "ref",
        { ref: "rr_000000000000000000000000" } as unknown as ReadBatchInput,
        undefined,
        undefined,
        context(directory),
      ),
    ).rejects.toThrow(/unsupported request field "ref"/u);

    await expect(
      tool.execute(
        "flow",
        { flowId: "flow-a" } as unknown as ReadBatchInput,
        undefined,
        undefined,
        context(directory),
      ),
    ).rejects.toThrow(/unsupported request field "flowId"/u);

    await expect(
      tool.execute(
        "covers",
        { covers: ["ac-1"] } as unknown as ReadBatchInput,
        undefined,
        undefined,
        context(directory),
      ),
    ).rejects.toThrow(/unsupported request field "covers"/u);

    await expect(
      tool.execute(
        "publish",
        {
          paths: [{ path: "src/one.ts" }],
          publish: { flowId: "flow-a" },
        } as unknown as ReadBatchInput,
        undefined,
        undefined,
        context(directory),
      ),
    ).rejects.toThrow(/unsupported request field "publish"/u);
  });

  it("returns neither publish nor lookup blocks and no per-item refs", async () => {
    const { directory, configPath } = await setupDirectory();
    const tool = createReadBatchToolForTesting({ configPath });

    const first = await tool.execute(
      "first",
      { paths: [{ path: "src/one.ts" }] },
      undefined,
      undefined,
      context(directory),
    );

    expect(Object.keys(first.details).sort()).toEqual(["results"]);
    expect(Object.keys(first.details.results[0] ?? {}).sort()).toEqual([
      "content",
      "contentHash",
      "output",
      "path",
      "unchanged",
    ]);
    expect(first.structuredContent).toEqual(first.details);
    expect(Check(readBatchDetailsSchema, first.structuredContent)).toBe(true);

    const repeat = await tool.execute(
      "repeat",
      { paths: [{ path: "src/one.ts" }] },
      undefined,
      undefined,
      context(directory),
    );

    expect(Object.keys(repeat.details.results[0] ?? {}).sort()).toEqual([
      "contentHash",
      "path",
      "unchanged",
    ]);
    expect(repeat.details.results[0]).toMatchObject({ unchanged: true });
    expect(Check(readBatchDetailsSchema, repeat.structuredContent)).toBe(true);
  });

  it("records invocation format version 2 without lookup or publication fields", () => {
    const input: ReadBatchInvocationRecordInput = {
      sessionId: "session-1",
      toolCallId: "call-1",
      schemaHash: "schema-hash",
      requestedPaths: 1,
      reason: "completed",
      executed: true,
      durationMs: 1,
    };

    const record = buildReadBatchInvocationRecord(input);

    expect(record.invocationFormatVersion).toBe(2);
    expect(Object.hasOwn(record, "lookup")).toBe(false);
    expect(Object.hasOwn(record, "publication")).toBe(false);
    expect(record.items.every((item) => !Object.hasOwn(item, "ref"))).toBe(true);
  });
});
