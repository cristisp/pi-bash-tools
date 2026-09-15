import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { createVerifyEvidenceCache } from "../../src/tools/verify/cache.ts";
import type { VerifyEvidenceRecord, VerifyPhase } from "../../src/tools/verify/types.ts";

const fixtureDirectories: string[] = [];
const PHASES: readonly VerifyPhase[] = ["format", "lint", "typecheck", "test"];

afterEach(async () => {
  await Promise.all(
    fixtureDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function step(phase: VerifyPhase): VerifyEvidenceRecord["perStep"][number] {
  return {
    phase,
    status: "passed",
    verdict: "passed",
    command: `pnpm run ${phase}`,
    resolvedCommand: `pnpm run ${phase}`,
    executable: "pnpm",
    args: ["run", phase],
    exitCode: 0,
    signal: null,
    durationMs: 1,
    executed: true,
    stdout: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
    stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
  };
}

function record(key: string): VerifyEvidenceRecord {
  return {
    cacheFormatVersion: 3,
    key,
    ref: `vr_${key.slice(0, 24)}`,
    projectPath: "/tmp/verify-project",
    resolvedCommands: ["pnpm run format"],
    perStep: PHASES.map((phase) => step(phase)),
    verdict: "passed",
    covers: [],
    createdAt: 0,
  };
}

async function withFlowScope<T>(flowId: string | undefined, run: () => Promise<T>): Promise<T> {
  const previousFlow = process.env.PI_ORCHESTRATION_FLOW;
  const previousScope = process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE;
  if (flowId === undefined) {
    delete process.env.PI_ORCHESTRATION_FLOW;
    delete process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE;
  } else {
    process.env.PI_ORCHESTRATION_FLOW = flowId;
    process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE = "flow";
  }
  try {
    return await run();
  } finally {
    if (previousFlow === undefined) delete process.env.PI_ORCHESTRATION_FLOW;
    else process.env.PI_ORCHESTRATION_FLOW = previousFlow;
    if (previousScope === undefined) delete process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE;
    else process.env.PI_ORCHESTRATION_EVIDENCE_SCOPE = previousScope;
  }
}

function flowCacheDirectory(cacheRoot: string, flowId: string): string {
  return join(cacheRoot, "flows", flowId, "project-command");
}

async function jsonEntries(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((file) => file.endsWith(".json"));
}

it("writes one disk entry per flow record and resolves it by request key and ref", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "bash-tools-verify-cache-layout-"));
  fixtureDirectories.push(cacheRoot);
  await withFlowScope("verify-layout-flow", async () => {
    const entry = record("single-write-key");
    const cache = createVerifyEvidenceCache({ rootDirectory: cacheRoot });
    cache.set(entry);
    expect(await jsonEntries(flowCacheDirectory(cacheRoot, "verify-layout-flow"))).toHaveLength(1);
    expect(cache.get(entry.key)).toEqual(entry);
    expect(cache.getByRef(entry.ref)).toEqual(entry);
    const consumer = createVerifyEvidenceCache({ rootDirectory: cacheRoot });
    expect(consumer.get(entry.key)).toEqual(entry);
    expect(consumer.getByRef(entry.ref)).toEqual(entry);
  });
});

it("publishes one disk entry to the target flow and keeps other flows dark", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "bash-tools-verify-cache-publish-"));
  fixtureDirectories.push(cacheRoot);
  await withFlowScope(undefined, async () => {
    const entry: VerifyEvidenceRecord = {
      ...record("publish-layout-key"),
      repositoryState: {
        repositoryIdentity: "/repo",
        workingDirectory: "/tmp/verify-project",
        head: "HEAD",
        dirtyFilesDigest: "clean",
      },
    };
    const publisher = createVerifyEvidenceCache({ rootDirectory: cacheRoot });
    publisher.set(entry);
    const published = publisher.publish?.(entry.ref, "verify-publish-target-flow", "/repo");
    expect(published?.publication).toMatchObject({
      flowId: "verify-publish-target-flow",
      published: true,
    });
    expect(
      await jsonEntries(flowCacheDirectory(cacheRoot, "verify-publish-target-flow")),
    ).toHaveLength(1);
    await withFlowScope("verify-publish-target-flow", async () => {
      const seat = createVerifyEvidenceCache({ rootDirectory: cacheRoot });
      expect(seat.getByRef(entry.ref)).toEqual(published);
    });
    await withFlowScope("verify-unrelated-flow", async () => {
      expect(
        createVerifyEvidenceCache({ rootDirectory: cacheRoot }).getByRef(entry.ref),
      ).toBeUndefined();
    });
  });
});

it("resolves a legacy double-write record by ref, misses it by request key, and overwrites it in place", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "bash-tools-verify-cache-legacy-"));
  fixtureDirectories.push(cacheRoot);
  await withFlowScope("verify-legacy-flow", async () => {
    const entry = record("legacy-era-key");
    const cache = createVerifyEvidenceCache({ rootDirectory: cacheRoot });
    cache.set(entry);
    const directory = flowCacheDirectory(cacheRoot, "verify-legacy-flow");
    const [soleFile] = await jsonEntries(directory);
    expect(soleFile).toBeDefined();
    const legacyRecord = { ...entry, cacheFormatVersion: 2 };
    await writeFile(
      join(directory, soleFile),
      JSON.stringify({ key: `ref:${entry.ref}`, record: legacyRecord }),
    );
    const reader = createVerifyEvidenceCache({ rootDirectory: cacheRoot });
    expect(reader.getByRef(entry.ref)).toEqual(legacyRecord);
    expect(reader.get(entry.key)).toBeUndefined();
    cache.set(entry);
    const reloaded = createVerifyEvidenceCache({ rootDirectory: cacheRoot });
    expect((await jsonEntries(directory)).length).toBe(1);
    expect(reloaded.get(entry.key)).toEqual(entry);
    expect(reloaded.getByRef(entry.ref)).toEqual(entry);
  });
});

it("misses a corrupt flow record fail-closed for both lookups", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "bash-tools-verify-cache-corrupt-"));
  fixtureDirectories.push(cacheRoot);
  await withFlowScope("verify-corrupt-flow", async () => {
    const entry = record("corrupt-fixture-key");
    createVerifyEvidenceCache({ rootDirectory: cacheRoot }).set(entry);
    const directory = flowCacheDirectory(cacheRoot, "verify-corrupt-flow");
    await Promise.all(
      (await jsonEntries(directory)).map((file) => writeFile(join(directory, file), "{}")),
    );
    const reader = createVerifyEvidenceCache({ rootDirectory: cacheRoot });
    expect(reader.get(entry.key)).toBeUndefined();
    expect(reader.getByRef(entry.ref)).toBeUndefined();
  });
});
