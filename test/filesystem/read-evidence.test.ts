/* oxlint-disable typescript/no-unsafe-type-assertion */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReadBatchInvocationRecord } from "../../src/observability/read-batch-invocation.ts";
import {
  createReadBatchToolForTesting,
  type ReadBatchToolContext,
} from "../../src/tools/filesystem/read-batch-tool.ts";
import {
  readEvidenceNotFoundError,
  resolveReadEvidenceLookup,
  type ReadEvidenceLookupStatus,
} from "../../src/tools/filesystem/read-evidence-lookup.ts";
import {
  createPublishedReadEvidenceRecord,
  createReadEvidenceStore,
  createReadEvidenceStoreInternal,
  type ReadEvidenceEntry,
  type ReadEvidenceRecord,
  type ReadEvidenceStore,
} from "../../src/tools/filesystem/read-evidence-store.ts";
import { isReadEvidenceRecord } from "../../src/tools/filesystem/read-evidence-validation.ts";
import { createPolicyTestFixtures } from "../policy/test-fixtures.ts";

const fixtures = createPolicyTestFixtures();
const execFileAsync = promisify(execFile);

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await fixtures.cleanup();
});

async function withFlow<T>(flowId: string, run: () => Promise<T>): Promise<T> {
  vi.stubEnv("PI_ORCHESTRATION_FLOW", flowId);
  vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
  return run();
}

function context(cwd: string): ReadBatchToolContext {
  return {
    cwd,
    mode: "print",
    hasUI: false,
    signal: undefined,
    ui: { select: async () => undefined },
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function entry(path: string, content: string): ReadEvidenceEntry {
  return {
    path,
    contentHash: sha256(content),
    content,
    output: {
      truncated: false,
      totalBytes: Buffer.byteLength(content, "utf8"),
      totalLines: content.split("\n").length,
    },
  };
}

function fakeStore(record: ReadEvidenceRecord | undefined): ReadEvidenceStore {
  return {
    getByRef: () => record,
    lookupOutcome: () => (record === undefined ? "missing" : "found"),
    publish: () => true,
    clear: () => undefined,
  };
}

const FAKE_DISK = {
  get: () => undefined,
  set: () => true,
  publish: () => true,
  delete: () => undefined,
  clear: () => undefined,
  tryClaim: () => undefined,
  releaseClaim: () => undefined,
};

describe("read evidence store", () => {
  it("publishes to the caller's authorized flow and reads back durable records", async () => {
    const directory = await fixtures.createDirectory();
    const cacheRoot = join(await realpath(directory), "cache");
    const flowId = "flow-evidence";
    await withFlow(flowId, async () => {
      const store = createReadEvidenceStore({ rootDirectory: cacheRoot });
      const record = createPublishedReadEvidenceRecord({
        root: "/repo",
        flowId,
        entries: [entry("src/one.ts", "first\n")],
      });
      expect(store.publish(record, flowId)).toBe(true);
      expect(store.getByRef(record.ref, flowId)).toEqual(record);
      expect(store.lookupOutcome?.(record.ref, flowId)).toBe("found");
      expect(store.getByRef(record.ref, "flow-other")).toBeUndefined();

      const reopened = createReadEvidenceStore({ rootDirectory: cacheRoot });
      expect(reopened.getByRef(record.ref, flowId)).toEqual(record);
    });
  });

  it("does not retain a ref when the durable flow write fails", async () => {
    const record = createPublishedReadEvidenceRecord({
      root: "/repo",
      flowId: "flow-write-failure",
      entries: [entry("src/one.ts", "first\n")],
    });
    await withFlow("flow-write-failure", async () => {
      const store = createReadEvidenceStoreInternal({}, isReadEvidenceRecord, () => ({
        ...FAKE_DISK,
        publish: () => false,
      }));
      expect(store.publish(record, "flow-write-failure")).toBe(false);
      expect(store.getByRef(record.ref, "flow-write-failure")).toBeUndefined();
    });
  });

  it("rejects publication outside the caller's authorized flow", async () => {
    const directory = await fixtures.createDirectory();
    const cacheRoot = join(await realpath(directory), "cache");
    await withFlow("flow-a", async () => {
      const store = createReadEvidenceStore({ rootDirectory: cacheRoot });
      const record = createPublishedReadEvidenceRecord({
        root: "/repo",
        flowId: "flow-b",
        entries: [entry("a.ts", "x")],
      });
      expect(store.publish(record, "flow-b")).toBe(false);
      expect(store.getByRef(record.ref, "flow-b")).toBeUndefined();
      expect(store.getByRef(record.ref, "flow-a")).toBeUndefined();
    });
  });

  it("trims published evidence at the per-flow bound", async () => {
    const directory = await fixtures.createDirectory();
    const cacheRoot = join(await realpath(directory), "cache");
    const flowId = "flow-trim";
    await withFlow(flowId, async () => {
      const store = createReadEvidenceStore({ rootDirectory: cacheRoot });
      const refs: string[] = [];
      for (let index = 0; index < 129; index += 1) {
        const record = createPublishedReadEvidenceRecord({
          root: "/repo",
          flowId,
          entries: [entry(`file-${index}.ts`, `content-${index}`)],
        });
        expect(store.publish(record, flowId)).toBe(true);
        refs.push(record.ref);
      }
      expect(store.lookupOutcome?.(refs[0] ?? "", flowId)).toBe("missing");
      expect(store.lookupOutcome?.(refs.at(-1) ?? "", flowId)).toBe("found");
    });
  });

  it("classifies an in-process invalid record as corrupt", async () => {
    const directory = await fixtures.createDirectory();
    const cacheRoot = join(await realpath(directory), "cache");
    const flowId = "flow-corrupt";
    await withFlow(flowId, async () => {
      let calls = 0;
      const store = createReadEvidenceStoreInternal(
        { rootDirectory: cacheRoot },
        (value, scopeKey): value is ReadEvidenceRecord => {
          calls += 1;
          return calls === 1 && isReadEvidenceRecord(value, scopeKey);
        },
        () => FAKE_DISK,
      );
      const record = createPublishedReadEvidenceRecord({
        root: "/repo",
        flowId,
        entries: [entry("a.ts", "x")],
      });
      expect(store.publish(record, flowId)).toBe(true);
      expect(store.lookupOutcome?.(record.ref, flowId)).toBe("corrupt");
      expect(store.getByRef(record.ref, flowId)).toBeUndefined();
    });
  });

  it("rejects malformed evidence records", () => {
    const record = createPublishedReadEvidenceRecord({
      root: "/repo",
      flowId: "flow-1",
      entries: [entry("a.ts", "x")],
    });
    expect(isReadEvidenceRecord(record)).toBe(true);
    expect(isReadEvidenceRecord({ ...record, entries: [] })).toBe(false);
    expect(isReadEvidenceRecord({ ...record, ref: "rr_short" })).toBe(false);
    expect(isReadEvidenceRecord({ ...record, provenance: { scope: "session" } })).toBe(false);
    expect(isReadEvidenceRecord(record, "flow-2")).toBe(false);
  });

  it("recomputes the record content hash and ref from the stored entries", () => {
    const valid = createPublishedReadEvidenceRecord({
      root: "/repo",
      flowId: "flow-1",
      entries: [entry("a.ts", "x")],
    });
    expect(isReadEvidenceRecord(valid)).toBe(true);
    expect(isReadEvidenceRecord({ ...valid, contentHash: sha256("unrelated") })).toBe(false);
    expect(isReadEvidenceRecord({ ...valid, ref: "rr_000000000000000000000000" })).toBe(false);
    const first = valid.entries[0];
    if (first === undefined) throw new Error("expected a recorded entry");
    expect(
      isReadEvidenceRecord({ ...valid, entries: [{ ...first, contentHash: sha256("other") }] }),
    ).toBe(false);
  });

  it("cannot recompute the request hash because records omit the request root", () => {
    const valid = createPublishedReadEvidenceRecord({
      root: "/repo",
      flowId: "flow-1",
      entries: [entry("a.ts", "x")],
    });
    expect(isReadEvidenceRecord({ ...valid, requestHash: sha256("substituted") })).toBe(true);
  });
});

describe("read evidence lookup", () => {
  const record = createPublishedReadEvidenceRecord({
    root: "/repo",
    flowId: "flow-1",
    entries: [entry("a.ts", "alpha"), entry("b.ts", "beta"), entry("c.ts", "gamma")],
  });

  it("reauthorizes each recorded path and reports per-path status", async () => {
    const statuses: Record<string, ReadEvidenceLookupStatus> = {
      "a.ts": "unchanged",
      "b.ts": "changed",
      "c.ts": "unreadable",
    };
    const result = await resolveReadEvidenceLookup({
      store: fakeStore(record),
      ref: record.ref,
      requestedFlowId: undefined,
      flowId: "flow-1",
      covers: ["AC-038"],
      unauthorizedFlow: false,
      probePath: async (candidate) => ({
        status: statuses[candidate.path] ?? "unchanged",
        content: candidate.content,
      }),
      observeWorkspace: async () => undefined,
      onOutcome: () => undefined,
    });
    expect(result.executed).toBe(false);
    expect(result.repositoryStateStatus).toBe("unreadable");
    expect(result.covers).toEqual(["AC-038"]);
    expect(result.entries.map((item) => item.status)).toEqual([
      "unchanged",
      "changed",
      "unreadable",
    ]);
    expect(result.entries[0]?.content).toBe("alpha");
    expect(result.entries[1]?.content).toBeUndefined();
    expect(result.entries[2]?.content).toBeUndefined();
  });

  it("keeps unauthorized and unreadable distinct", async () => {
    const result = await resolveReadEvidenceLookup({
      store: fakeStore(record),
      ref: record.ref,
      requestedFlowId: undefined,
      flowId: "flow-1",
      covers: undefined,
      unauthorizedFlow: false,
      probePath: async () => ({ status: "unauthorized" }),
      observeWorkspace: async () => undefined,
      onOutcome: () => undefined,
    });
    expect(result.entries[0]?.status).toBe("unauthorized");
    expect(result.entries[0]?.content).toBeUndefined();
  });

  it("refuses stored content that differs from the re-derived current content", async () => {
    const genuine = createPublishedReadEvidenceRecord({
      root: "/repo",
      flowId: "flow-1",
      entries: [entry("a.ts", "alpha")],
    });
    const first = genuine.entries[0];
    if (first === undefined) throw new Error("expected a recorded entry");
    const tampered: ReadEvidenceRecord = {
      ...genuine,
      entries: Object.freeze([Object.freeze({ ...first, content: "evil" })]),
    };
    const result = await resolveReadEvidenceLookup({
      store: fakeStore(tampered),
      ref: tampered.ref,
      requestedFlowId: undefined,
      flowId: "flow-1",
      covers: undefined,
      unauthorizedFlow: false,
      probePath: async () => ({ status: "unchanged", content: "alpha" }),
      observeWorkspace: async () => undefined,
      onOutcome: () => undefined,
    });
    expect(result.entries[0]?.status).not.toBe("unchanged");
    expect(result.entries[0]?.content).toBeUndefined();
    expect(result.entries[0]?.output).toBeUndefined();
  });

  it("returns stored content when it matches the re-derived current content", async () => {
    const result = await resolveReadEvidenceLookup({
      store: fakeStore(record),
      ref: record.ref,
      requestedFlowId: undefined,
      flowId: "flow-1",
      covers: undefined,
      unauthorizedFlow: false,
      probePath: async (candidate) => ({ status: "unchanged", content: candidate.content }),
      observeWorkspace: async () => undefined,
      onOutcome: () => undefined,
    });
    expect(result.entries[0]?.status).toBe("unchanged");
    expect(result.entries[0]?.content).toBe("alpha");
  });

  it("serves re-derived output metadata instead of tampered stored output", async () => {
    const genuine = createPublishedReadEvidenceRecord({
      root: "/repo",
      flowId: "flow-1",
      entries: [entry("a.ts", "alpha")],
    });
    const first = genuine.entries[0];
    if (first === undefined) throw new Error("expected a recorded entry");
    const tampered: ReadEvidenceRecord = {
      ...genuine,
      entries: Object.freeze([
        Object.freeze({
          ...first,
          output: Object.freeze({ truncated: true, totalBytes: 999_999, totalLines: 42 }),
        }),
      ]),
    };
    const derived = Object.freeze({ truncated: false, totalBytes: 5, totalLines: 1 });
    const result = await resolveReadEvidenceLookup({
      store: fakeStore(tampered),
      ref: tampered.ref,
      requestedFlowId: undefined,
      flowId: "flow-1",
      covers: undefined,
      unauthorizedFlow: false,
      probePath: async () => ({ status: "unchanged", content: "alpha", output: derived }),
      observeWorkspace: async () => undefined,
      onOutcome: () => undefined,
    });
    expect(result.entries[0]?.status).toBe("unchanged");
    expect(result.entries[0]?.content).toBe("alpha");
    expect(result.entries[0]?.output).toEqual(derived);
  });

  it("uses one generic not-found wording for unauthorized and authorized-missing lookups", async () => {
    const ref = "rr_0123456789abcdef01234567";
    const outcomes: string[] = [];
    const run = async (
      options: Partial<Parameters<typeof resolveReadEvidenceLookup>[0]>,
    ): Promise<string> => {
      try {
        await resolveReadEvidenceLookup({
          store: fakeStore(undefined),
          ref,
          requestedFlowId: undefined,
          flowId: "flow-1",
          covers: undefined,
          unauthorizedFlow: false,
          probePath: async () => ({ status: "unchanged", content: "alpha" }),
          observeWorkspace: async () => undefined,
          onOutcome: () => undefined,
          ...options,
        });
        return "no-error";
      } catch (error) {
        return error instanceof Error ? error.message : "non-error";
      }
    };
    outcomes.push(
      await run({ requestedFlowId: "flow-2", flowId: "flow-1", unauthorizedFlow: true }),
    );
    outcomes.push(await run({}));
    outcomes.push(
      await run({
        store: {
          getByRef: () => undefined,
          lookupOutcome: () => "corrupt",
          publish: () => true,
          clear: () => undefined,
        },
      }),
    );
    const expected = readEvidenceNotFoundError(ref, "flow-1").message;
    expect(outcomes).toEqual([expected, expected, expected]);
  });
});

describe("read_batch evidence publication", () => {
  it("publishes a fresh read and resolves it on lookup", async () => {
    const directory = await fixtures.createDirectory();
    const canonical = await realpath(directory);
    await writeFile(join(canonical, "src.ts"), "first\nsecond\n");
    const configPath = join(canonical, "bash-tools.json");
    await writeFile(configPath, JSON.stringify({ version: 1 }));
    const store = createReadEvidenceStore({ rootDirectory: join(canonical, "cache") });
    await withFlow("flow-1", async () => {
      const tool = createReadBatchToolForTesting({ configPath, readEvidenceStore: store });
      const read = await tool.execute(
        "read",
        { paths: [{ path: "src.ts" }], publish: { flowId: "flow-1" } },
        undefined,
        undefined,
        context(canonical),
      );
      expect(Object.keys(read.details).sort()).toEqual(["publish", "results"]);
      expect(read.details.publish?.published).toBe(true);
      const ref = read.details.publish?.ref ?? "";
      expect(ref).toMatch(/^rr_[0-9a-f]{24}$/u);

      const lookup = await tool.execute(
        "lookup",
        { ref },
        undefined,
        undefined,
        context(canonical),
      );
      expect(lookup.details.lookup?.executed).toBe(false);
      expect(lookup.details.lookup?.entries[0]?.status).toBe("unchanged");
      expect(lookup.details.lookup?.entries[0]?.content).toContain("first");

      await writeFile(join(canonical, "src.ts"), "changed\n");
      const changed = await tool.execute(
        "lookup-changed",
        { ref },
        undefined,
        undefined,
        context(canonical),
      );
      expect(changed.details.lookup?.entries[0]?.status).toBe("changed");
      expect(changed.details.lookup?.entries[0]?.content).toBeUndefined();

      await rm(join(canonical, "src.ts"));
      const unreadable = await tool.execute(
        "lookup-unreadable",
        { ref },
        undefined,
        undefined,
        context(canonical),
      );
      expect(unreadable.details.lookup?.entries[0]?.status).toBe("unreadable");
    });
  });

  it("resolves a published ref from a fresh child process", async () => {
    const directory = await fixtures.createDirectory();
    const canonical = await realpath(directory);
    const cacheRoot = join(canonical, "cache");
    await writeFile(join(canonical, "src.ts"), "first\nsecond\n");
    const configPath = join(canonical, "bash-tools.json");
    await writeFile(configPath, JSON.stringify({ version: 1 }));
    const store = createReadEvidenceStore({ rootDirectory: cacheRoot });
    await withFlow("flow-child", async () => {
      const tool = createReadBatchToolForTesting({ configPath, readEvidenceStore: store });
      const published = await tool.execute(
        "publish-child",
        { paths: [{ path: "src.ts" }], publish: { flowId: "flow-child" } },
        undefined,
        undefined,
        context(canonical),
      );
      const ref = published.details.publish?.ref;
      expect(ref).toMatch(/^rr_[0-9a-f]{24}$/u);
      if (ref === undefined) throw new Error("expected a published ref");

      const readBatchUrl = new URL("../../src/tools/filesystem/read-batch-tool.ts", import.meta.url)
        .href;
      const evidenceStoreUrl = new URL(
        "../../src/tools/filesystem/read-evidence-store.ts",
        import.meta.url,
      ).href;
      const childCode = `
        const { createReadBatchToolForTesting } = await import(${JSON.stringify(readBatchUrl)});
        const { createReadEvidenceStore } = await import(${JSON.stringify(evidenceStoreUrl)});
        const tool = createReadBatchToolForTesting({
          configPath: process.env.BASH_TOOLS_CONFIG,
          readEvidenceStore: createReadEvidenceStore({ rootDirectory: process.env.BASH_TOOLS_CACHE }),
        });
        const context = {
          cwd: process.env.BASH_TOOLS_CWD,
          mode: "print",
          hasUI: false,
          signal: undefined,
          ui: { select: async () => undefined },
        };
        const result = await tool.execute(
          "lookup-child",
          { ref: process.env.BASH_TOOLS_REF, covers: ["AC-CHILD"] },
          undefined,
          undefined,
          context,
        );
        console.log(JSON.stringify({
          ref: result.details.lookup?.ref,
          status: result.details.lookup?.entries[0]?.status,
        }));
      `;
      const child = await execFileAsync(
        process.execPath,
        ["--input-type=module", "--eval", childCode],
        {
          cwd: canonical,
          env: {
            ...process.env,
            BASH_TOOLS_CACHE: cacheRoot,
            BASH_TOOLS_CONFIG: configPath,
            BASH_TOOLS_CWD: canonical,
            BASH_TOOLS_REF: ref,
            PI_ORCHESTRATION_FLOW: "flow-child",
            PI_ORCHESTRATION_EVIDENCE_SCOPE: "flow",
          },
        },
      );
      expect(JSON.parse(child.stdout)).toEqual({ ref, status: "unchanged" });
    });
  });

  it("records a clamped lookup outcome without read-phase items", async () => {
    const directory = await fixtures.createDirectory();
    const canonical = await realpath(directory);
    await writeFile(join(canonical, "src.ts"), "first\n");
    const configPath = join(canonical, "bash-tools.json");
    await writeFile(configPath, JSON.stringify({ version: 1 }));
    const store = createReadEvidenceStore({ rootDirectory: join(canonical, "cache") });
    await withFlow("flow-1", async () => {
      const records: ReadBatchInvocationRecord[] = [];
      const tool = createReadBatchToolForTesting({
        configPath,
        readEvidenceStore: store,
        invocationRecorder: (record) => {
          records.push(record);
        },
      });
      const sessionContext = {
        ...context(canonical),
        sessionManager: { getSessionId: () => "session-1" },
      };
      const read = await tool.execute(
        "read",
        { paths: [{ path: "src.ts" }], publish: { flowId: "flow-1" } },
        undefined,
        undefined,
        sessionContext,
      );
      const ref = read.details.publish?.ref ?? "";
      await tool.execute("lookup", { ref }, undefined, undefined, sessionContext);
      const lookupRecord = records.find((candidate) => candidate.lookup !== undefined);
      expect(lookupRecord?.lookup).toEqual({
        attempted: true,
        success: true,
        outcome: "success",
      });
      expect(lookupRecord?.items).toEqual([]);
      expect(lookupRecord?.aggregate.contentBytes).toBe(0);

      await expect(
        tool.execute(
          "missing",
          { ref: "rr_0123456789abcdef01234567" },
          undefined,
          undefined,
          sessionContext,
        ),
      ).rejects.toThrow(/not found/u);
      const failureRecord = records
        .filter((candidate) => candidate.lookup?.success === false)
        .at(-1);
      expect(failureRecord?.lookup?.outcome).toBe("not-found");
    });
  });

  it("keeps paths-only results unchanged and rejects invalid lookup requests", async () => {
    const directory = await fixtures.createDirectory();
    const canonical = await realpath(directory);
    await writeFile(join(canonical, "a.ts"), "alpha\n");
    const configPath = join(canonical, "bash-tools.json");
    await writeFile(configPath, JSON.stringify({ version: 1 }));
    const tool = createReadBatchToolForTesting({ configPath });
    const read = await tool.execute(
      "read",
      { paths: [{ path: "a.ts" }] },
      undefined,
      undefined,
      context(canonical),
    );
    expect(Object.keys(read.details)).toEqual(["results"]);
    expect(read.details.publish).toBeUndefined();

    await expect(
      tool.execute(
        "mixed",
        { ref: "rr_0123456789abcdef01234567", paths: [{ path: "a.ts" }] },
        undefined,
        undefined,
        context(canonical),
      ),
    ).rejects.toThrow(/unsupported request field "paths"/u);
    await expect(
      tool.execute(
        "publish-lookup",
        { ref: "rr_0123456789abcdef01234567", publish: { flowId: "flow-1" } },
        undefined,
        undefined,
        context(canonical),
      ),
    ).rejects.toThrow(/unsupported request field "publish"/u);
    await expect(
      tool.execute(
        "unknown",
        { paths: [{ path: "a.ts" }], bogus: true } as never,
        undefined,
        undefined,
        context(canonical),
      ),
    ).rejects.toThrow(/unsupported request field "bogus"/u);
  });

  it("does not publish to a flow the caller is not authorized for", async () => {
    const directory = await fixtures.createDirectory();
    const canonical = await realpath(directory);
    await mkdir(join(canonical, "src"));
    await writeFile(join(canonical, "src", "a.ts"), "alpha\n");
    const configPath = join(canonical, "bash-tools.json");
    await writeFile(configPath, JSON.stringify({ version: 1 }));
    const store = createReadEvidenceStore({ rootDirectory: join(canonical, "cache") });
    await withFlow("flow-1", async () => {
      const tool = createReadBatchToolForTesting({ configPath, readEvidenceStore: store });
      const read = await tool.execute(
        "read",
        { paths: [{ path: "src/a.ts" }], publish: { flowId: "flow-2" } },
        undefined,
        undefined,
        context(canonical),
      );
      expect(read.details.publish?.published).toBe(false);
      expect(read.details.publish?.ref).toBeUndefined();
      expect(read.details.results[0]?.content).toContain("alpha");
    });
  });

  it("reports publication failure when the store throws", async () => {
    const directory = await fixtures.createDirectory();
    const canonical = await realpath(directory);
    await writeFile(join(canonical, "src.ts"), "alpha\n");
    const configPath = join(canonical, "bash-tools.json");
    await writeFile(configPath, JSON.stringify({ version: 1 }));
    const store: ReadEvidenceStore = {
      getByRef: () => undefined,
      lookupOutcome: () => "missing",
      publish: () => {
        throw new Error("cache unavailable");
      },
      clear: () => undefined,
    };
    await withFlow("flow-throw", async () => {
      const tool = createReadBatchToolForTesting({ configPath, readEvidenceStore: store });
      const read = await tool.execute(
        "publish-throw",
        { paths: [{ path: "src.ts" }], publish: { flowId: "flow-throw" } },
        undefined,
        undefined,
        context(canonical),
      );
      expect(read.details.publish).toEqual({
        scope: "flow",
        flowId: "flow-throw",
        published: false,
        error: "Read evidence was not published to the requested flow.",
      });
    });
  });

  it("rejects a cross-flow lookup before probing the store", async () => {
    const directory = await fixtures.createDirectory();
    const canonical = await realpath(directory);
    const configPath = join(canonical, "bash-tools.json");
    await writeFile(configPath, JSON.stringify({ version: 1 }));
    const getByRef = vi.fn(() => undefined);
    const store: ReadEvidenceStore = {
      getByRef,
      lookupOutcome: () => "missing",
      publish: () => false,
      clear: () => undefined,
    };
    await withFlow("flow-1", async () => {
      const tool = createReadBatchToolForTesting({ configPath, readEvidenceStore: store });
      const ref = "rr_0123456789abcdef01234567";
      await expect(
        tool.execute("lookup", { ref, flowId: "flow-2" }, undefined, undefined, context(canonical)),
      ).rejects.toThrow(readEvidenceNotFoundError(ref, "flow-1").message);
      expect(getByRef).not.toHaveBeenCalled();
    });
  });

  it("fails closed when a stored record's content diverges from the current file bytes", async () => {
    const directory = await fixtures.createDirectory();
    const canonical = await realpath(directory);
    await writeFile(join(canonical, "a.ts"), "alpha\n");
    const configPath = join(canonical, "bash-tools.json");
    await writeFile(configPath, JSON.stringify({ version: 1 }));
    const store = createReadEvidenceStore({ rootDirectory: join(canonical, "cache") });
    await withFlow("flow-1", async () => {
      const tool = createReadBatchToolForTesting({ configPath, readEvidenceStore: store });
      const read = await tool.execute(
        "publish",
        { paths: [{ path: "a.ts" }], publish: { flowId: "flow-1" } },
        undefined,
        undefined,
        context(canonical),
      );
      const ref = read.details.publish?.ref ?? "";
      const genuine = store.getByRef(ref, "flow-1");
      if (genuine === undefined) throw new Error("expected a published record");
      const first = genuine.entries[0];
      if (first === undefined) throw new Error("expected a recorded entry");
      expect(
        store.publish(
          { ...genuine, entries: Object.freeze([Object.freeze({ ...first, content: "evil\n" })]) },
          "flow-1",
        ),
      ).toBe(true);
      const lookup = await tool.execute(
        "tampered",
        { ref },
        undefined,
        undefined,
        context(canonical),
      );
      expect(lookup.details.lookup?.entries[0]?.status).not.toBe("unchanged");
      expect(lookup.details.lookup?.entries[0]?.content).toBeUndefined();
    });
  });

  it("serves re-derived output metadata instead of tampered stored output", async () => {
    const directory = await fixtures.createDirectory();
    const canonical = await realpath(directory);
    await writeFile(join(canonical, "a.ts"), "alpha\n");
    const configPath = join(canonical, "bash-tools.json");
    await writeFile(configPath, JSON.stringify({ version: 1 }));
    const store = createReadEvidenceStore({ rootDirectory: join(canonical, "cache") });
    await withFlow("flow-1", async () => {
      const tool = createReadBatchToolForTesting({ configPath, readEvidenceStore: store });
      const read = await tool.execute(
        "publish",
        { paths: [{ path: "a.ts" }], publish: { flowId: "flow-1" } },
        undefined,
        undefined,
        context(canonical),
      );
      const ref = read.details.publish?.ref ?? "";
      const genuine = store.getByRef(ref, "flow-1");
      if (genuine === undefined) throw new Error("expected a published record");
      const first = genuine.entries[0];
      if (first === undefined) throw new Error("expected a recorded entry");
      const derived = first.output;
      expect(
        store.publish(
          {
            ...genuine,
            entries: Object.freeze([
              Object.freeze({
                ...first,
                output: Object.freeze({ truncated: true, totalBytes: 999_999, totalLines: 42 }),
              }),
            ]),
          },
          "flow-1",
        ),
      ).toBe(true);
      const lookup = await tool.execute(
        "tampered-output",
        { ref },
        undefined,
        undefined,
        context(canonical),
      );
      expect(lookup.details.lookup?.entries[0]?.status).toBe("unchanged");
      expect(lookup.details.lookup?.entries[0]?.output).toEqual(derived);
    });
  });

  it("returns an unauthorized content-free entry when the recorded path is denied at lookup", async () => {
    const directory = await fixtures.createDirectory();
    const canonical = await realpath(directory);
    await writeFile(join(canonical, "a.ts"), "alpha\n");
    const configPath = join(canonical, "bash-tools.json");
    await writeFile(configPath, JSON.stringify({ version: 1 }));
    const store = createReadEvidenceStore({ rootDirectory: join(canonical, "cache") });
    await withFlow("flow-1", async () => {
      const tool = createReadBatchToolForTesting({ configPath, readEvidenceStore: store });
      const read = await tool.execute(
        "publish",
        { paths: [{ path: "a.ts" }], publish: { flowId: "flow-1" } },
        undefined,
        undefined,
        context(canonical),
      );
      const ref = read.details.publish?.ref ?? "";
      expect(ref).toMatch(/^rr_[0-9a-f]{24}$/u);
      await writeFile(
        configPath,
        JSON.stringify({
          version: 4,
          environment: { version: 1 },
          projectCommands: { version: 1 },
          filesystem: {
            version: 2,
            global: { allowRead: [], allowWrite: [], denyRead: [], denyWrite: [] },
            projects: {
              [canonical]: {
                allowRead: [],
                allowWrite: [],
                denyRead: [join(canonical, "a.ts")],
                denyWrite: [],
              },
            },
          },
        }),
      );
      const lookup = await tool.execute(
        "denied",
        { ref },
        undefined,
        undefined,
        context(canonical),
      );
      expect(lookup.details.lookup?.entries[0]?.status).toBe("unauthorized");
      expect(lookup.details.lookup?.entries[0]?.content).toBeUndefined();
      expect(lookup.details.lookup?.entries[0]?.output).toBeUndefined();
    });
  });

  it("reports a distinct bounded error when a conforming publication exceeds the serialized bound", async () => {
    const directory = await fixtures.createDirectory();
    const canonical = await realpath(directory);
    const names = ["a.ts", "b.ts", "c.ts", "d.ts"];
    await Promise.all(names.map((name) => writeFile(join(canonical, name), '"'.repeat(64 * 1024))));
    const configPath = join(canonical, "bash-tools.json");
    await writeFile(configPath, JSON.stringify({ version: 1 }));
    const store = createReadEvidenceStore({ rootDirectory: join(canonical, "cache") });
    await withFlow("flow-1", async () => {
      const tool = createReadBatchToolForTesting({ configPath, readEvidenceStore: store });
      const read = await tool.execute(
        "publish",
        { paths: names.map((name) => ({ path: name })), publish: { flowId: "flow-1" } },
        undefined,
        undefined,
        context(canonical),
      );
      expect(read.details.publish?.published).toBe(false);
      expect(read.details.publish?.error).toBe(
        "Read evidence exceeds the published record size bound.",
      );
    });
  });

  it("reports published false when the filesystem policy cannot be loaded", async () => {
    const directory = await fixtures.createDirectory();
    const canonical = await realpath(directory);
    await writeFile(join(canonical, "a.ts"), "alpha\n");
    const configPath = join(canonical, "bash-tools.json");
    await writeFile(configPath, "{");
    const store = createReadEvidenceStore({ rootDirectory: join(canonical, "cache") });
    await withFlow("flow-1", async () => {
      const tool = createReadBatchToolForTesting({ configPath, readEvidenceStore: store });
      const read = await tool.execute(
        "publish",
        { paths: [{ path: "a.ts" }], publish: { flowId: "flow-1" } },
        undefined,
        undefined,
        context(canonical),
      );
      expect(read.details.results[0]?.error?.code).toBe("policy-load-failure");
      expect(read.details.publish).toEqual({
        scope: "flow",
        flowId: "flow-1",
        published: false,
        error: "Read evidence was not published because the filesystem policy could not be loaded.",
      });
    });
  });
});
