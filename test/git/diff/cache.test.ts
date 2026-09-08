/* oxlint-disable no-await-in-loop */

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import {
  createGitDiffSummaryCache,
  type GitDiffSummaryCacheState,
} from "../../../src/tools/git/diff/cache.ts";
import type { GitDiffSummaryOutput } from "../../../src/tools/git/diff/output.ts";
import { MAX_CONTENT_BYTES, MAX_RECORDS } from "../../../src/tools/git/output.ts";
import {
  createProjectCommandDiskJsonCache,
  type ProjectCommandDiskCacheClaim,
  type ProjectCommandDiskJsonCache,
} from "../../../src/tools/project-command/cache.ts";

const state: GitDiffSummaryCacheState = {
  repositoryIdentity: "/repo",
  workingDirectory: "/repo/packages/app",
  head: "head-a",
  dirtyFilesDigest: "dirty-a",
  staged: false,
  paths: ["src"],
  maxBytes: 16 * 1024,
};

const statusEntry = { path: "src/app.ts", indexStatus: " ", worktreeStatus: "M" };
const hunk = { path: "src/app.ts", header: "@@ -1 +1 @@" };
const summary: GitDiffSummaryOutput = {
  mode: "summary",
  status: [statusEntry],
  stat: " src/app.ts | 1 +\n",
  hunks: [hunk],
  output: { truncated: false, totalBytes: 1_024, totalLines: 1 },
  message: "complete summary",
};

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createDiskCache(root: string): ProjectCommandDiskJsonCache {
  return createProjectCommandDiskJsonCache({ rootDirectory: root }, isObject);
}

type MutableRecord = Record<string, unknown>;

function mutableRecord(value: unknown): MutableRecord {
  if (!isObject(value)) throw new Error("expected a record");
  return value;
}

function nestedRecord(record: MutableRecord, key: string): MutableRecord {
  return mutableRecord(record[key]);
}

function arrayItemRecord(record: MutableRecord, key: string, index = 0): MutableRecord {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error("expected an array");
  return mutableRecord(value[index]);
}

function createMemoryDiskCache(): {
  readonly diskCache: ProjectCommandDiskJsonCache;
  readonly records: Map<string, unknown>;
  readonly setCalls: Array<{ readonly scope: string; readonly key: string }>;
  readonly releaseCalls: ProjectCommandDiskCacheClaim[];
} {
  const records = new Map<string, unknown>();
  const claims = new Map<string, ProjectCommandDiskCacheClaim>();
  const setCalls: Array<{ readonly scope: string; readonly key: string }> = [];
  const releaseCalls: ProjectCommandDiskCacheClaim[] = [];
  const recordKey = (scope: string, key: string) => `${scope}:${key}`;
  const diskCache: ProjectCommandDiskJsonCache = {
    get: (scope, key) => records.get(recordKey(scope, key)),
    set: (scope, key, record) => {
      records.set(recordKey(scope, key), record);
      setCalls.push({ scope, key });
      return true;
    },
    publish: (scope, key, record) => {
      records.set(recordKey(scope, key), record);
      return true;
    },
    delete: (scope, key) => {
      records.delete(recordKey(scope, key));
    },
    clear: () => {
      records.clear();
    },
    tryClaim: (scope, key) => {
      const keyForClaim = recordKey(scope, key);
      if (claims.has(keyForClaim)) return undefined;
      const claim = { claimId: Symbol() };
      claims.set(keyForClaim, claim);
      return claim;
    },
    releaseClaim: (claim) => {
      releaseCalls.push(claim);
      for (const [key, storedClaim] of claims) {
        if (storedClaim.claimId === claim.claimId) claims.delete(key);
      }
    },
  };
  return { diskCache, records, setCalls, releaseCalls };
}

async function expectPersistedMiss(
  cache: ReturnType<typeof createGitDiffSummaryCache>,
  path: string,
  serializedValidRecord: string,
  mutate: (record: MutableRecord) => void,
): Promise<void> {
  await writeFile(path, serializedValidRecord);
  const record = mutableRecord(JSON.parse(serializedValidRecord));
  mutate(record);
  await writeFile(path, JSON.stringify(record));
  expect(cache.get(state)).toBeUndefined();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

it("hits a local entry and misses before setting or for every changed state component", () => {
  const memory = createMemoryDiskCache();
  const cache = createGitDiffSummaryCache({ diskCache: memory.diskCache });

  expect(cache.get(state)).toBeUndefined();
  cache.set(state, summary);
  expect(cache.get(state)).toEqual(summary);
  expect(memory.setCalls).toHaveLength(0);

  const changedStates: GitDiffSummaryCacheState[] = [
    { ...state, repositoryIdentity: "/other-repo" },
    { ...state, workingDirectory: "/repo/other" },
    { ...state, head: "head-b" },
    { ...state, dirtyFilesDigest: "dirty-b" },
    { ...state, staged: true },
    { ...state, paths: ["tests"] },
    { ...state, maxBytes: 8 * 1024 },
  ];
  for (const changedState of changedStates) {
    expect(cache.get(changedState)).toBeUndefined();
  }
});

it("keeps the no-environment cache process-local", async () => {
  const root = await mkdtemp(join(tmpdir(), "bash-tools-git-diff-cache-"));
  try {
    const first = createGitDiffSummaryCache({ diskCache: createDiskCache(root) });
    const second = createGitDiffSummaryCache({ diskCache: createDiskCache(root) });

    first.set(state, summary);

    expect(second.get(state)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects malformed serialized records before returning a cache hit", async () => {
  vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
  vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
  const root = await mkdtemp(join(tmpdir(), "bash-tools-git-diff-cache-"));
  try {
    const cache = createGitDiffSummaryCache({ diskCache: createDiskCache(root) });
    cache.set(state, summary);
    const directory = join(root, "flows", "flow-a", "project-command");
    const [name] = await readdir(directory);
    if (name === undefined) throw new Error("cache entry was not written");
    const path = join(directory, name);
    const valid = await readFile(path, "utf8");

    for (const malformed of ["{", "null", "[]", JSON.stringify({})]) {
      await writeFile(path, malformed);
      expect(cache.get(state)).toBeUndefined();
    }
    await writeFile(path, "x".repeat(2 * 1024 * 1024 + 1));
    expect(cache.get(state)).toBeUndefined();
    await writeFile(path, valid);
    expect(cache.get(state)).toEqual(summary);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects a bounded-summary record with a mismatched key or oversized status", async () => {
  vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
  vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
  const root = await mkdtemp(join(tmpdir(), "bash-tools-git-diff-cache-"));
  try {
    const cache = createGitDiffSummaryCache({ diskCache: createDiskCache(root) });
    cache.set(state, summary);
    const directory = join(root, "flows", "flow-a", "project-command");
    const [name] = await readdir(directory);
    if (name === undefined) throw new Error("cache entry was not written");
    const valid = await readFile(join(directory, name), "utf8");
    await writeFile(
      join(directory, name),
      valid.replace(/"key":"[a-f0-9]+"/u, '"key":"wrong-key"'),
    );
    expect(cache.get(state)).toBeUndefined();

    await expectPersistedMiss(cache, join(directory, name), valid, (record) => {
      nestedRecord(record, "summary").status = Array.from(
        { length: MAX_RECORDS + 1 },
        () => statusEntry,
      );
    });

    cache.set(state, summary);
    const persisted = await readFile(join(directory, name), "utf8");
    await writeFile(join(directory, name), persisted.replace(/,"flowId":"flow-a"\}$/u, "}"));
    expect(cache.get(state)).toBeUndefined();

    cache.set(state, summary);
    const withInvalidFlow = await readFile(join(directory, name), "utf8");
    await writeFile(join(directory, name), withInvalidFlow.replace("flow-a", "invalid!"));
    expect(cache.get(state)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects state values outside every persisted state bound", async () => {
  vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
  vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
  const root = await mkdtemp(join(tmpdir(), "bash-tools-git-diff-cache-"));
  try {
    const cache = createGitDiffSummaryCache({ diskCache: createDiskCache(root) });
    cache.set(state, summary);
    const directory = join(root, "flows", "flow-a", "project-command");
    const [name] = await readdir(directory);
    if (name === undefined) throw new Error("cache entry was not written");
    const path = join(directory, name);
    const valid = await readFile(path, "utf8");
    await expectPersistedMiss(cache, path, valid, (record) => {
      record.state = null;
    });
    await expectPersistedMiss(cache, path, valid, (record) => {
      record.summary = null;
    });
    const invalidStateValues: Array<(value: MutableRecord) => void> = [
      (value) => {
        value.repositoryIdentity = 3;
      },
      (value) => {
        value.repositoryIdentity = "";
      },
      (value) => {
        value.repositoryIdentity = "x".repeat(4_097);
      },
      (value) => {
        value.workingDirectory = 3;
      },
      (value) => {
        value.workingDirectory = "";
      },
      (value) => {
        value.workingDirectory = "x".repeat(4_097);
      },
      (value) => {
        value.head = 3;
      },
      (value) => {
        value.head = "";
      },
      (value) => {
        value.head = "x".repeat(257);
      },
      (value) => {
        value.dirtyFilesDigest = 3;
      },
      (value) => {
        value.dirtyFilesDigest = "";
      },
      (value) => {
        value.dirtyFilesDigest = "x".repeat(257);
      },
      (value) => {
        value.staged = "false";
      },
      (value) => {
        value.paths = "src";
      },
      (value) => {
        value.paths = Array.from({ length: MAX_RECORDS + 1 }, () => "src");
      },
      (value) => {
        value.paths = [3];
      },
      (value) => {
        value.paths = ["x".repeat(4_097)];
      },
      (value) => {
        value.maxBytes = "16384";
      },
      (value) => {
        value.maxBytes = -1;
      },
      (value) => {
        value.maxBytes = 1.5;
      },
      (value) => {
        value.maxBytes = 0;
      },
      (value) => {
        value.maxBytes = MAX_CONTENT_BYTES + 1;
      },
      (value) => {
        value.maxBytes = Number.MAX_SAFE_INTEGER + 1;
      },
    ];
    for (const mutateState of invalidStateValues) {
      await expectPersistedMiss(cache, path, valid, (record) => {
        mutateState(nestedRecord(record, "state"));
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects summary values outside every persisted summary bound", async () => {
  vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
  vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
  const root = await mkdtemp(join(tmpdir(), "bash-tools-git-diff-cache-"));
  try {
    const cache = createGitDiffSummaryCache({ diskCache: createDiskCache(root) });
    cache.set(state, summary);
    const directory = join(root, "flows", "flow-a", "project-command");
    const [name] = await readdir(directory);
    if (name === undefined) throw new Error("cache entry was not written");
    const path = join(directory, name);
    const valid = await readFile(path, "utf8");
    const invalidSummaryValues: Array<(value: MutableRecord) => void> = [
      (value) => {
        value.mode = "patch";
      },
      (value) => {
        value.status = {};
      },
      (value) => {
        value.status = Array.from({ length: MAX_RECORDS + 1 }, () => statusEntry);
      },
      (value) => {
        value.status = [null];
      },
      (value) => {
        value.status = [{ ...statusEntry, path: 3 }];
      },
      (value) => {
        value.status = [{ ...statusEntry, path: "x".repeat(4_097) }];
      },
      (value) => {
        value.status = [{ ...statusEntry, indexStatus: "XYZ" }];
      },
      (value) => {
        value.status = [{ ...statusEntry, worktreeStatus: "XYZ" }];
      },
      (value) => {
        value.status = [{ ...statusEntry, renamedFrom: null }];
      },
      (value) => {
        value.status = [{ ...statusEntry, renamedFrom: "x".repeat(4_097) }];
      },
      (value) => {
        value.hunks = {};
      },
      (value) => {
        value.hunks = Array.from({ length: MAX_RECORDS + 1 }, () => hunk);
      },
      (value) => {
        value.hunks = [null];
      },
      (value) => {
        value.hunks = [{ ...hunk, path: 3 }];
      },
      (value) => {
        value.hunks = [{ ...hunk, path: "x".repeat(4_097) }];
      },
      (value) => {
        value.hunks = [{ ...hunk, header: 3 }];
      },
      (value) => {
        value.hunks = [{ ...hunk, header: "x".repeat(4_097) }];
      },
      (value) => {
        value.stat = 3;
      },
      (value) => {
        value.stat = "x".repeat(MAX_CONTENT_BYTES + 1);
      },
      (value) => {
        value.message = 3;
      },
      (value) => {
        value.message = "x".repeat(MAX_CONTENT_BYTES + 1);
      },
      (value) => {
        value.output = null;
      },
      (value) => {
        nestedRecord(value, "output").truncated = "false";
      },
      (value) => {
        nestedRecord(value, "output").totalBytes = -1;
      },
      (value) => {
        nestedRecord(value, "output").totalBytes = 1.5;
      },
      (value) => {
        nestedRecord(value, "output").totalBytes = MAX_CONTENT_BYTES * 4_096 + 1;
      },
      (value) => {
        nestedRecord(value, "output").totalLines = -1;
      },
      (value) => {
        nestedRecord(value, "output").totalLines = 1.5;
      },
      (value) => {
        nestedRecord(value, "output").totalLines = 4_096_001;
      },
    ];
    for (const mutateSummary of invalidSummaryValues) {
      await expectPersistedMiss(cache, path, valid, (record) => {
        mutateSummary(nestedRecord(record, "summary"));
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects summaries that violate the response-limit bounds", async () => {
  vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
  vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
  const root = await mkdtemp(join(tmpdir(), "bash-tools-git-diff-cache-"));
  try {
    const cache = createGitDiffSummaryCache({ diskCache: createDiskCache(root) });
    cache.set(state, summary);
    const directory = join(root, "flows", "flow-a", "project-command");
    const [name] = await readdir(directory);
    if (name === undefined) throw new Error("cache entry was not written");
    const path = join(directory, name);
    const valid = await readFile(path, "utf8");
    const invalidBounds: Array<(record: MutableRecord) => void> = [
      (record) => {
        nestedRecord(record, "state").maxBytes = 1;
      },
      (record) => {
        nestedRecord(nestedRecord(record, "summary"), "output").totalBytes = 0;
      },
      (record) => {
        const output = nestedRecord(nestedRecord(record, "summary"), "output");
        output.truncated = false;
        output.totalBytes = state.maxBytes + 1;
      },
      (record) => {
        const summaryRecord = nestedRecord(record, "summary");
        nestedRecord(summaryRecord, "output").truncated = true;
        summaryRecord.message = "complete summary";
      },
      (record) => {
        arrayItemRecord(nestedRecord(record, "summary"), "hunks").header = "not a hunk";
      },
    ];
    for (const mutateRecord of invalidBounds) {
      await expectPersistedMiss(cache, path, valid, mutateRecord);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("accepts state and summary values at their documented record bounds", () => {
  vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
  vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
  const memory = createMemoryDiskCache();
  const cache = createGitDiffSummaryCache({ diskCache: memory.diskCache });
  const boundaryPath = "x".repeat(4_096);
  const boundaryHeader = `@@ ${"x".repeat(4_093)}`;
  const boundaryState: GitDiffSummaryCacheState = {
    repositoryIdentity: boundaryPath,
    workingDirectory: boundaryPath,
    head: "x".repeat(256),
    dirtyFilesDigest: "x".repeat(256),
    staged: true,
    paths: [
      boundaryPath,
      ...Array.from({ length: MAX_RECORDS - 1 }, (_, index) => `path-${index}`),
    ],
    maxBytes: MAX_CONTENT_BYTES,
  };
  const boundarySummary: GitDiffSummaryOutput = {
    mode: "summary",
    status: [
      {
        path: boundaryPath,
        indexStatus: "XY",
        worktreeStatus: "XY",
        renamedFrom: boundaryPath,
      },
      ...Array.from({ length: MAX_RECORDS - 1 }, (_, index) => ({
        path: `path-${index}`,
        indexStatus: " ",
        worktreeStatus: "M",
      })),
    ],
    stat: "stat",
    hunks: [
      { path: boundaryPath, header: boundaryHeader },
      ...Array.from({ length: MAX_RECORDS - 1 }, (_, index) => ({
        path: `path-${index}`,
        header: "@@ -1 +1 @@",
      })),
    ],
    output: {
      truncated: true,
      totalBytes: MAX_CONTENT_BYTES * 4_096,
      totalLines: 4_096_000,
    },
    message: "INCOMPLETE summary",
  };

  cache.set(boundaryState, boundarySummary);
  expect(cache.get(boundaryState)).toEqual(boundarySummary);
});

it("rejects cache records with invalid envelopes and derived keys", () => {
  vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
  vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
  const memory = createMemoryDiskCache();
  const cache = createGitDiffSummaryCache({ diskCache: memory.diskCache });
  const invalidRecordValues: Array<(record: MutableRecord) => void> = [
    (record) => {
      record.cacheFormatVersion = 2;
    },
    (record) => {
      record.key = "wrong-key";
    },
    (record) => {
      delete record.key;
    },
    (record) => {
      delete record.flowId;
    },
    (record) => {
      record.flowId = "invalid!";
    },
    (record) => {
      record.flowId = "flow-b";
    },
  ];
  for (const mutateRecord of invalidRecordValues) {
    cache.set(state, summary);
    const record = mutableRecord([...memory.records.values()][0]);
    mutateRecord(record);
    expect(cache.get(state)).toBeUndefined();
  }
});

it("invalidates a hit when the stored state no longer equals the requested state", () => {
  vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
  vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
  const memory = createMemoryDiskCache();
  const cache = createGitDiffSummaryCache({ diskCache: memory.diskCache });
  cache.set(state, summary);
  const record = mutableRecord([...memory.records.values()][0]);
  nestedRecord(record, "state").head = "head-b";
  expect(cache.get(state)).toBeUndefined();
});

it("coordinates local claims and only releases the current local owner", () => {
  const cache = createGitDiffSummaryCache({ diskCache: createMemoryDiskCache().diskCache });
  const first = cache.tryClaim(state);
  if (first === undefined) throw new Error("first claim was not acquired");
  expect(cache.tryClaim(state)).toBeUndefined();

  cache.releaseClaim({ ...first, claimId: Symbol() });
  expect(cache.tryClaim(state)).toBeUndefined();
  cache.releaseClaim(first);
  const replacement = cache.tryClaim(state);
  if (replacement === undefined) throw new Error("replacement claim was not acquired");
  cache.releaseClaim(first);
  expect(cache.tryClaim(state)).toBeUndefined();
  cache.releaseClaim(replacement);
  expect(cache.tryClaim(state)).toBeDefined();
});

it("delegates flow claims to the disk cache and releases disk claims", () => {
  vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
  vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
  const memory = createMemoryDiskCache();
  const cache = createGitDiffSummaryCache({ diskCache: memory.diskCache });

  const first = cache.tryClaim(state);
  if (first === undefined) throw new Error("first claim was not acquired");
  expect(cache.tryClaim(state)).toBeUndefined();
  expect(first.scope).toBe("flow-a");
  expect(first.diskClaim).toBeDefined();

  cache.releaseClaim(first);
  expect(memory.releaseCalls).toHaveLength(1);
  expect(cache.tryClaim(state)).toBeDefined();
});

it("shares only an authorized flow snapshot and invalidates changed state", async () => {
  vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
  vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
  const root = await mkdtemp(join(tmpdir(), "bash-tools-git-diff-cache-"));
  try {
    const first = createGitDiffSummaryCache({ diskCache: createDiskCache(root) });
    const second = createGitDiffSummaryCache({ diskCache: createDiskCache(root) });

    first.set(state, summary);

    expect(second.get(state)).toEqual(summary);
    expect(second.get({ ...state, dirtyFilesDigest: "dirty-b" })).toBeUndefined();

    vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-b");
    const otherFlow = createGitDiffSummaryCache({ diskCache: createDiskCache(root) });
    expect(otherFlow.get(state)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
