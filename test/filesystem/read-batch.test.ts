import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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

function context(cwd: string): ReadBatchToolContext {
  return {
    cwd,
    mode: "print",
    hasUI: false,
    signal: undefined,
    ui: { select: async () => undefined },
  };
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
