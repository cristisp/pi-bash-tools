import { mkdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import {
  createProjectCommandDiskJsonCache,
  createProjectCommandDiskResultCache,
  type ProjectCommandCacheProvenance,
  type ProjectCommandResultCache,
  type ProjectCommandResultCacheEntry,
} from "../../src/tools/project-command/cache.ts";
import {
  projectCommandIdentity,
  type ProjectCommandDefinition,
} from "../../src/tools/project-command/definitions.ts";
import type { ProjectCommandOutputDetails } from "../../src/tools/project-command/output.ts";
import type { ProjectCommandRepositoryState } from "../../src/tools/project-command/repository-state.ts";
import { resolveFixedProjectCommand } from "../../src/tools/project-command/resolution.ts";
import { createProjectCommandToolForTesting } from "../../src/tools/project-command/tool.ts";
import { cleanupProjectCommandFixtures, context, fixture } from "./tool-test-fixtures.ts";

const cacheDefinition = {
  namespace: "bash-tools.project-command",
  commandId: "flow_cache_command",
  description: "A deterministic flow cache test command.",
  executable: "/bin/echo",
  args: ["cache"],
  cwdStrategy: "canonical-project",
  sanitizedEnvironmentProfile: "minimal-static-v1",
  processTimeoutMs: 30_000,
  outputLimitBytes: 50 * 1024,
  risk: "workspace-observation",
  globalSafe: true,
  reusePolicy: "project-metadata",
} satisfies ProjectCommandDefinition<"flow_cache_command">;

const definitions = [cacheDefinition] as const;
const cacheSnapshot = { version: 1 as const, entries: [] };
const cacheDetails = {
  commandId: "flow_cache_command",
  projectPath: "/repo",
  fingerprint: "fingerprint",
  authFingerprint: "auth-fingerprint",
  toolCallId: "producer",
  reused: false,
  forced: false,
  cacheDecision: "miss" as const,
  durationMs: 1,
  executionDurationMs: 1,
  scope: { cwdStrategy: "canonical-project" as const, projectPath: "/repo" },
  status: "success" as const,
  category: "PASS" as const,
  executed: true,
  exit: { code: 0, signal: null },
  timedOut: false,
  cancelled: false,
  stdout: { text: "value", truncated: false, totalBytes: 5, totalLines: 1 },
  stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
  output: {
    stdout: { truncated: false, totalBytes: 5, totalLines: 1 },
    stderr: { truncated: false, totalBytes: 0, totalLines: 0 },
  },
  resolvedCommand: "/bin/echo cache",
  parameters: { commandId: "flow_cache_command" },
} satisfies ProjectCommandOutputDetails;

function provenance(
  overrides: Partial<ProjectCommandCacheProvenance> = {},
): ProjectCommandCacheProvenance {
  return {
    producerSessionId: "producer-session",
    producerRole: "worker",
    flowId: "flow-a",
    repositoryIdentity: "/repo",
    workingDirectory: "/repo",
    head: "head-a",
    dirtyFilesDigest: "dirty-a",
    snapshotDigest: "snapshot-a",
    writeTimestamp: Date.now(),
    ...overrides,
  };
}

function cacheEntry(
  logicalRequestKey = "request-a",
  overrides: Partial<ProjectCommandCacheProvenance> = {},
): ProjectCommandResultCacheEntry {
  return {
    logicalRequestKey,
    resultFingerprint: `fingerprint-${logicalRequestKey}`,
    details: cacheDetails,
    snapshot: cacheSnapshot,
    producerInvocationId: "producer-call",
    provenance: provenance(overrides),
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function persistedLogicalRequestKey(value: unknown): string {
  if (!isRecord(value) || typeof value.logicalRequestKey !== "string") {
    throw new Error("cache entry has no logical request key");
  }
  return value.logicalRequestKey;
}

function replaceLockWithFreshOwner(lockPath: string): void {
  const displacedPath = `${lockPath}.test-displaced`;
  renameSync(lockPath, displacedPath);
  rmSync(displacedPath, { force: true, recursive: true });
  const temporaryPath = `${lockPath}.test-replacement`;
  mkdirSync(temporaryPath, { mode: 0o700 });
  writeFileSync(join(temporaryPath, "owner-replacement.token"), "replacement", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporaryPath, lockPath);
}

async function cacheFile(root: string, flowId: string): Promise<string> {
  const directory = join(root, "flows", flowId, "project-command");
  const names = await readdir(directory);
  const name = names.find((value) => value.endsWith(".json"));
  if (name === undefined) throw new Error("cache entry was not written");
  return join(directory, name);
}

function createReplayCache(): {
  readonly cache: ProjectCommandResultCache;
  getEntry: () => ProjectCommandResultCacheEntry | undefined;
  setEntry: (entry: ProjectCommandResultCacheEntry) => void;
} {
  let stored: ProjectCommandResultCacheEntry | undefined;
  return {
    cache: {
      get: () => stored,
      set: (_sessionId, entry) => {
        stored = entry;
      },
      delete: () => {
        stored = undefined;
      },
      clear: () => {
        stored = undefined;
      },
    },
    getEntry: () => stored,
    setEntry: (cacheRecord) => {
      stored = cacheRecord;
    },
  };
}

async function authorize(data: { readonly directory: string; readonly configPath: string }) {
  const projectPath = await realpath(data.directory);
  const resolved = resolveFixedProjectCommand(cacheDefinition);
  await writeFile(
    data.configPath,
    JSON.stringify({
      version: 2,
      environment: { version: 1 },
      projectCommands: {
        version: 1,
        global: { allow: [], deny: [] },
        projects: {
          [projectPath]: {
            allow: [projectCommandIdentity(cacheDefinition, resolved)],
            deny: [],
          },
        },
      },
    }),
  );
}

function relevantInputDiscovery() {
  return {
    discover: async () => ({
      status: "complete" as const,
      inputs: { files: [], values: [] },
    }),
  };
}

function authorizeFlow(flowId: string): void {
  vi.stubEnv("PI_ORCHESTRATION_FLOW", flowId);
  vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
}

function successOutcome(text: string) {
  return {
    status: "success" as const,
    exit: { code: 0, signal: null },
    timedOut: false,
    cancelled: false,
    stdout: { text, truncated: false, totalBytes: text.length, totalLines: 1 },
    stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupProjectCommandFixtures();
});

it("shares a flow entry across separate cache instances but isolates other flows", async () => {
  authorizeFlow("flow-a");
  const root = await mkdtemp(join(tmpdir(), "bash-tools-flow-cache-"));
  try {
    const producer = createProjectCommandDiskResultCache({
      rootDirectory: root,
      scopeKey: "flow-a",
    });
    const consumer = createProjectCommandDiskResultCache({
      rootDirectory: root,
      scopeKey: "flow-a",
    });
    const otherFlow = createProjectCommandDiskResultCache({
      rootDirectory: root,
      scopeKey: "flow-b",
    });

    producer.set("flow-a", cacheEntry());

    expect(consumer.get("flow-a", "request-a")).toMatchObject({
      logicalRequestKey: "request-a",
      producerInvocationId: "producer-call",
    });
    expect(otherFlow.get("flow-a", "request-a")).toBeUndefined();
    expect(otherFlow.get("flow-b", "request-a")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("treats corrupt and partial disk entries as misses", async () => {
  authorizeFlow("flow-a");
  const root = await mkdtemp(join(tmpdir(), "bash-tools-flow-cache-"));
  try {
    const cache = createProjectCommandDiskResultCache({ rootDirectory: root, scopeKey: "flow-a" });
    cache.set("flow-a", cacheEntry());
    const path = await cacheFile(root, "flow-a");

    await writeFile(path, '{"cacheFormatVersion":1,');
    expect(cache.get("flow-a", "request-a")).toBeUndefined();

    await writeFile(path, "not-json");
    expect(cache.get("flow-a", "request-a")).toBeUndefined();

    await writeFile(path, "x".repeat(2 * 1024 * 1024 + 1));
    expect(cache.get("flow-a", "request-a")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not let an old claim owner release a replacement claim", async () => {
  authorizeFlow("flow-a");
  const root = await mkdtemp(join(tmpdir(), "bash-tools-flow-cache-"));
  try {
    const validator = () => true;
    const first = createProjectCommandDiskJsonCache({ rootDirectory: root }, validator);
    const second = first;
    const third = createProjectCommandDiskJsonCache({ rootDirectory: root }, validator);
    const firstClaim = first.tryClaim("flow-a", "claim-key");
    if (firstClaim === undefined) throw new Error("first claim was not acquired");
    const claimDirectory = join(root, "flows", "flow-a", "project-command");
    const claimName = (await readdir(claimDirectory)).find((name) => name.endsWith(".claim"));
    if (claimName === undefined) throw new Error("claim was not written");
    const claimPath = join(claimDirectory, claimName);
    const ownerName = (await readdir(claimPath)).find((name) => name.startsWith("owner-"));
    if (ownerName === undefined) throw new Error("claim owner was not written");
    const old = new Date(Date.now() - 60_000);
    await utimes(join(claimPath, ownerName), old, old);

    const secondClaim = second.tryClaim("flow-a", "claim-key");
    if (secondClaim === undefined) throw new Error("second claim was not acquired");
    first.releaseClaim(firstClaim);
    expect(third.tryClaim("flow-a", "claim-key")).toBeUndefined();
    second.releaseClaim(secondClaim);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves a replacement claim when stale ownership is observed", async () => {
  authorizeFlow("flow-a");
  const root = await mkdtemp(join(tmpdir(), "bash-tools-flow-cache-"));
  let replacementCount = 0;
  try {
    const cache = createProjectCommandDiskJsonCache(
      {
        rootDirectory: root,
        beforeStaleOwnerRemoval: (lockPath) => {
          if (replacementCount === 0) {
            replacementCount += 1;
            replaceLockWithFreshOwner(lockPath);
          }
        },
      },
      () => true,
    );
    const firstClaim = cache.tryClaim("flow-a", "claim-key");
    if (firstClaim === undefined) throw new Error("claim was not written");
    const claimDirectory = join(root, "flows", "flow-a", "project-command");
    const claimName = (await readdir(claimDirectory)).find((name) => name.endsWith(".claim"));
    if (claimName === undefined) throw new Error("claim was not written");
    const claimPath = join(claimDirectory, claimName);
    const ownerName = (await readdir(claimPath)).find((name) => name.startsWith("owner-"));
    if (ownerName === undefined) throw new Error("claim owner was not written");
    const old = new Date(Date.now() - 60_000);
    await utimes(join(claimPath, ownerName), old, old);

    expect(cache.tryClaim("flow-a", "claim-key")).toBeUndefined();
    expect((await readdir(claimPath)).some((name) => name === "owner-replacement.token")).toBe(
      true,
    );
    cache.releaseClaim(firstClaim);
    expect(cache.tryClaim("flow-a", "claim-key")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves replacement global locks during stale directory and legacy recovery", async () => {
  const runCase = async (legacy: boolean): Promise<void> => {
    authorizeFlow("flow-a");
    const root = await mkdtemp(join(tmpdir(), "bash-tools-flow-cache-"));
    let replacementCount = 0;
    try {
      const lockPath = join(root, "flows.lock");
      const old = new Date(Date.now() - 60_000);
      if (legacy) {
        writeFileSync(lockPath, "stale", { encoding: "utf8", flag: "wx" });
      } else {
        mkdirSync(lockPath, { mode: 0o700 });
        writeFileSync(join(lockPath, "owner-stale.token"), "stale", {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      }
      utimesSync(legacy ? lockPath : join(lockPath, "owner-stale.token"), old, old);
      const cache = createProjectCommandDiskResultCache({
        rootDirectory: root,
        beforeStaleOwnerRemoval: (observedPath) => {
          if (replacementCount === 0 && observedPath === lockPath) {
            replacementCount += 1;
            replaceLockWithFreshOwner(observedPath);
            const replacementOwner = join(observedPath, "owner-replacement.token");
            utimesSync(replacementOwner, old, old);
          }
        },
      });

      cache.set("flow-a", cacheEntry("replacement-race"));
      expect(replacementCount).toBe(1);
      expect(cache.get("flow-a", "replacement-race")).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  await Promise.all([runCase(false), runCase(true)]);
});

it("steals an old exclusive lock and evicts entries by age and size", async () => {
  authorizeFlow("flow-a");
  const root = await mkdtemp(join(tmpdir(), "bash-tools-flow-cache-"));
  try {
    const cache = createProjectCommandDiskResultCache({ rootDirectory: root, scopeKey: "flow-a" });
    cache.set("flow-a", cacheEntry());
    const lockPath = join(root, "flows.lock");
    const old = new Date(Date.now() - 60_000);
    await writeFile(lockPath, "stale");
    await utimes(lockPath, old, old);
    cache.set("flow-a", cacheEntry("request-a", { head: "head-b" }));
    expect(cache.get("flow-a", "request-a")?.provenance?.head).toBe("head-b");

    let clock = Date.now();
    authorizeFlow("flow-age");
    const ageLimited = createProjectCommandDiskResultCache({
      rootDirectory: root,
      scopeKey: "flow-age",
      maxAgeMs: 10,
      now: () => clock,
    });
    ageLimited.set("flow-age", cacheEntry("age"));
    clock += 11;
    expect(ageLimited.get("flow-age", "age")).toBeUndefined();

    authorizeFlow("flow-size");
    const sizeLimited = createProjectCommandDiskResultCache({
      rootDirectory: root,
      scopeKey: "flow-size",
      maxBytes: 1,
    });
    sizeLimited.set("flow-size", cacheEntry("size"));
    expect(sizeLimited.get("flow-size", "size")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("accepts persisted records with uncapped real output totals", async () => {
  authorizeFlow("flow-a");
  const root = await mkdtemp(join(tmpdir(), "bash-tools-flow-cache-"));
  try {
    const cache = createProjectCommandDiskResultCache({ rootDirectory: root, scopeKey: "flow-a" });
    const realTotals = {
      ...cacheEntry(),
      details: {
        ...cacheDetails,
        stdout: { ...cacheDetails.stdout, totalBytes: 300 * 1024 * 1024, totalLines: 5_000_000 },
      },
    };
    cache.set("flow-a", realTotals);
    expect(cache.get("flow-a", "request-a")).toEqual({
      cacheFormatVersion: 1,
      ...realTotals,
      provenance: {
        ...realTotals.provenance,
        writeTimestamp: expect.any(Number),
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves cache-specific fractional duration validation", async () => {
  authorizeFlow("flow-a");
  const root = await mkdtemp(join(tmpdir(), "bash-tools-flow-cache-"));
  try {
    const cache = createProjectCommandDiskResultCache({ rootDirectory: root, scopeKey: "flow-a" });
    cache.set("flow-a", {
      ...cacheEntry(),
      details: { ...cacheDetails, durationMs: 1.5, executionDurationMs: 1.5 },
    });

    const reloaded = createProjectCommandDiskResultCache({
      rootDirectory: root,
      scopeKey: "flow-a",
    });
    expect(reloaded.get("flow-a", "request-a")?.details).toMatchObject({
      durationMs: 1.5,
      executionDurationMs: 1.5,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("treats a syntactically valid envelope with malformed details as a miss", async () => {
  authorizeFlow("flow-a");
  const root = await mkdtemp(join(tmpdir(), "bash-tools-flow-cache-"));
  try {
    const cache = createProjectCommandDiskResultCache({ rootDirectory: root, scopeKey: "flow-a" });
    cache.set("flow-a", cacheEntry());
    const path = await cacheFile(root, "flow-a");
    const persisted: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(persisted)) throw new Error("cache entry is not an object");
    await writeFile(path, JSON.stringify({ ...persisted, details: {} }));

    expect(cache.get("flow-a", "request-a")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("validates persisted error contracts and their optional fields", async () => {
  authorizeFlow("flow-a");
  const root = await mkdtemp(join(tmpdir(), "bash-tools-flow-cache-"));
  try {
    const cache = createProjectCommandDiskResultCache({ rootDirectory: root, scopeKey: "flow-a" });
    cache.set("flow-a", cacheEntry());
    const path = await cacheFile(root, "flow-a");
    const persisted: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(persisted)) throw new Error("cache entry is not an object");
    const validError = {
      code: "failed",
      category: "IMPLEMENTATION_FAILURE",
      explanation: "the command failed",
      invalidField: "commandId",
      suggestedAction: "retry",
      retryable: true,
      executed: true,
    };
    await writeFile(
      path,
      JSON.stringify({
        ...persisted,
        details: { ...cacheDetails, error: validError },
      }),
    );
    expect(cache.get("flow-a", "request-a")?.details.error).toEqual(validError);

    for (const [field, value] of [
      ["code", 1],
      ["category", 1],
      ["explanation", 1],
      ["invalidField", 1],
      ["suggestedAction", 1],
      ["retryable", "true"],
      ["executed", "true"],
    ] as const) {
      writeFileSync(
        path,
        JSON.stringify({
          ...persisted,
          details: { ...cacheDetails, error: { ...validError, [field]: value } },
        }),
      );
      expect(cache.get("flow-a", "request-a"), field).toBeUndefined();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("uses the flow namespace and records flow provenance across separate tools", async () => {
  const data = await fixture();
  await authorize(data);
  const root = await mkdtemp(join(tmpdir(), "bash-tools-flow-cache-"));
  const repositoryState: ProjectCommandRepositoryState = {
    repositoryIdentity: data.directory,
    head: "head-a",
    dirtyFilesDigest: "dirty-a",
  };
  vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
  vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
  vi.stubEnv("PI_ORCHESTRATION_ROLE", "worker");
  try {
    const firstExecutor = vi.fn(async () => successOutcome("producer"));
    const firstRecords: unknown[] = [];
    const first = createProjectCommandToolForTesting({
      configPath: data.configPath,
      definitions,
      executor: firstExecutor,
      relevantInputDiscovery: relevantInputDiscovery(),
      invocationRecorder: (record) => firstRecords.push(record),
      cache: createProjectCommandDiskResultCache({ rootDirectory: root, scopeKey: "flow-a" }),
      repositoryStateReader: async () => repositoryState,
    });
    const firstResult = await first.execute(
      "producer-call",
      { commandId: "flow_cache_command" },
      undefined,
      undefined,
      context(data.directory, { sessionManager: { getSessionId: () => "session-a" } }),
    );

    const persistedPath = await cacheFile(root, "flow-a");
    const persistedKey = persistedLogicalRequestKey(
      JSON.parse(await readFile(persistedPath, "utf8")),
    );
    expect(
      createProjectCommandDiskResultCache({ rootDirectory: root, scopeKey: "flow-a" }).get(
        "flow-a",
        persistedKey,
      ),
    ).toBeDefined();

    const secondExecutor = vi.fn(async () => successOutcome("consumer"));
    const secondRecords: unknown[] = [];
    const second = createProjectCommandToolForTesting({
      configPath: data.configPath,
      definitions,
      executor: secondExecutor,
      relevantInputDiscovery: relevantInputDiscovery(),
      invocationRecorder: (record) => secondRecords.push(record),
      cache: createProjectCommandDiskResultCache({ rootDirectory: root, scopeKey: "flow-a" }),
      repositoryStateReader: async () => repositoryState,
    });
    const secondResult = await second.execute(
      "consumer-call",
      { commandId: "flow_cache_command" },
      undefined,
      undefined,
      context(data.directory, { sessionManager: { getSessionId: () => "session-b" } }),
    );

    expect(firstExecutor).toHaveBeenCalledTimes(1);
    expect(secondExecutor).not.toHaveBeenCalled();
    expect(firstResult.details).toMatchObject({ cacheDecision: "miss", producerScope: "flow" });
    expect(secondResult.details).toMatchObject({
      cacheDecision: "hit",
      reused: true,
      producerInvocationId: "producer-call",
      producerScope: "flow",
    });
    expect(firstRecords[0]).toMatchObject({ producerScope: "flow" });
    expect(secondRecords[0]).toMatchObject({ producerScope: "flow", cacheDecision: "hit" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not let a no-environment session fallback read flow-scoped disk entries", async () => {
  const data = await fixture();
  await authorize(data);
  const root = await mkdtemp(join(tmpdir(), "bash-tools-flow-cache-"));
  const repositoryState: ProjectCommandRepositoryState = {
    repositoryIdentity: data.directory,
    head: "head-a",
    dirtyFilesDigest: "dirty-a",
  };
  vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
  vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
  vi.stubEnv("PI_ORCHESTRATION_ROLE", "worker");
  try {
    const producerExecutor = vi.fn(async () => successOutcome("producer"));
    const producer = createProjectCommandToolForTesting({
      configPath: data.configPath,
      definitions,
      executor: producerExecutor,
      relevantInputDiscovery: relevantInputDiscovery(),
      cache: createProjectCommandDiskResultCache({ rootDirectory: root, scopeKey: "flow-a" }),
      repositoryStateReader: async () => repositoryState,
    });
    await producer.execute(
      "producer-call",
      { commandId: "flow_cache_command" },
      undefined,
      undefined,
      context(data.directory, { sessionManager: { getSessionId: () => "session-a" } }),
    );
    expect(
      createProjectCommandDiskResultCache({ rootDirectory: root, scopeKey: "flow-a" }).get(
        "flow-a",
        "request-a",
      ),
    ).toBeUndefined();
    expect(await readdir(join(root, "flows", "flow-a", "project-command"))).not.toHaveLength(0);

    vi.stubEnv("PI_ORCHESTRATION_FLOW", undefined);
    vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", undefined);
    vi.stubEnv("PI_ORCHESTRATION_ROLE", undefined);
    const consumerExecutor = vi.fn(async () => successOutcome("consumer"));
    const consumer = createProjectCommandToolForTesting({
      configPath: data.configPath,
      definitions,
      executor: consumerExecutor,
      relevantInputDiscovery: relevantInputDiscovery(),
    });
    const result = await consumer.execute(
      "consumer-call",
      { commandId: "flow_cache_command" },
      undefined,
      undefined,
      context(data.directory, { sessionManager: { getSessionId: () => "session-b" } }),
    );

    expect(consumerExecutor).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({ cacheDecision: "miss", reused: false });
    expect(result.details.producerScope).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects injected disk caches outside the current authorized flow", async () => {
  const root = await mkdtemp(join(tmpdir(), "bash-tools-flow-cache-"));
  const cache = createProjectCommandDiskResultCache({ rootDirectory: root, scopeKey: "flow-a" });
  try {
    cache.set("flow-a", cacheEntry("unauthorized"));
    await expect(readdir(join(root, "flows"))).rejects.toThrow();

    authorizeFlow("flow-a");
    cache.set("flow-a", cacheEntry("allowed"));
    expect(cache.get("flow-a", "allowed")).toBeDefined();

    vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "session");
    expect(cache.get("flow-a", "allowed")).toBeUndefined();
    cache.set("flow-a", cacheEntry("session-write"));
    cache.delete("flow-a", "allowed");
    cache.clear();

    authorizeFlow("flow-a");
    expect(cache.get("flow-a", "allowed")).toBeDefined();
    expect(cache.get("flow-a", "session-write")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("coordinates delete and clear with the shared mutation lock", async () => {
  authorizeFlow("flow-a");
  const root = await mkdtemp(join(tmpdir(), "bash-tools-flow-cache-"));
  try {
    const cache = createProjectCommandDiskResultCache({ rootDirectory: root, scopeKey: "flow-a" });
    cache.set("flow-a", cacheEntry());
    const lockPath = join(root, "flows.lock");
    const stale = new Date(Date.now() - 60_000);
    await writeFile(lockPath, "stale");
    await utimes(lockPath, stale, stale);

    cache.delete("flow-a", "request-a");
    expect(cache.get("flow-a", "request-a")).toBeUndefined();

    cache.set("flow-a", cacheEntry("request-b"));
    await writeFile(lockPath, "stale");
    await utimes(lockPath, stale, stale);
    cache.clear();
    expect(cache.get("flow-a", "request-b")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("serializes delete and clear behind a writer before replacement", async () => {
  authorizeFlow("flow-a");
  const root = await mkdtemp(join(tmpdir(), "bash-tools-flow-cache-"));
  let running = false;
  const pending: Array<() => void> = [];
  const mutationLock = (operation: () => void): void => {
    if (running) {
      pending.push(operation);
      return;
    }
    running = true;
    try {
      operation();
    } finally {
      running = false;
      const next = pending.shift();
      if (next !== undefined) mutationLock(next);
    }
  };
  let cache: ProjectCommandResultCache;
  let raced = false;
  try {
    cache = createProjectCommandDiskResultCache({
      rootDirectory: root,
      scopeKey: "flow-a",
      mutationLock,
      beforeRename: () => {
        if (raced) return;
        raced = true;
        cache.delete("flow-a", "request-a");
        cache.clear();
      },
    });
    cache.set("flow-a", cacheEntry());
    expect(cache.get("flow-a", "request-a")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("invalidates flow entries for every required provenance mismatch", async () => {
  const data = await fixture();
  await authorize(data);
  const root = await mkdtemp(join(tmpdir(), "bash-tools-flow-cache-"));
  const repositoryState: ProjectCommandRepositoryState = {
    repositoryIdentity: data.directory,
    head: "head-a",
    dirtyFilesDigest: "dirty-a",
  };
  vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
  vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
  const mismatches: ReadonlyArray<{
    readonly label: string;
    readonly provenance: Partial<ProjectCommandCacheProvenance>;
  }> = [
    { label: "flow identity", provenance: { flowId: "flow-b" } },
    { label: "repository identity", provenance: { repositoryIdentity: "/other-repository" } },
    { label: "working directory", provenance: { workingDirectory: "/other-directory" } },
    { label: "HEAD", provenance: { head: "head-b" } },
    { label: "dirty state", provenance: { dirtyFilesDigest: "dirty-b" } },
    { label: "snapshot", provenance: { snapshotDigest: "snapshot-b" } },
  ];
  try {
    const replay = createReplayCache();
    const executor = vi.fn(async () => successOutcome(`run-${executor.mock.calls.length + 1}`));
    const tool = createProjectCommandToolForTesting({
      configPath: data.configPath,
      definitions,
      executor,
      relevantInputDiscovery: relevantInputDiscovery(),
      cache: replay.cache,
      repositoryStateReader: async () => repositoryState,
    });
    const first = await tool.execute(
      "first",
      { commandId: "flow_cache_command" },
      undefined,
      undefined,
      context(data.directory, { sessionManager: { getSessionId: () => "session-a" } }),
    );
    expect(first.details).toMatchObject({ cacheDecision: "miss" });

    const invalidateNext = async (index: number): Promise<void> => {
      const mismatch = mismatches[index];
      if (mismatch === undefined) return;
      const cached = replay.getEntry();
      if (cached?.provenance === undefined) {
        throw new Error(`missing provenance for ${mismatch.label}`);
      }
      replay.setEntry({
        ...cached,
        provenance: { ...cached.provenance, ...mismatch.provenance },
      });
      const changed = await tool.execute(
        `changed-${index}`,
        { commandId: "flow_cache_command" },
        undefined,
        undefined,
        context(data.directory, {
          sessionManager: { getSessionId: () => `session-${index + 1}` },
        }),
      );
      expect(changed.details).toMatchObject({ cacheDecision: "invalidated", reused: false });
      await invalidateNext(index + 1);
    };
    await invalidateNext(0);

    expect(executor).toHaveBeenCalledTimes(mismatches.length + 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
