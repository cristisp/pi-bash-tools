import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createProjectCommandDiskJsonCache,
  type ProjectCommandDiskJsonCache,
} from "../../../src/tools/project-command/cache.ts";
import {
  createGitDiffSummaryCache,
  type GitDiffSummaryCacheState,
} from "../../../src/tools/git/diff/cache.ts";
import type { GitDiffSummaryOutput } from "../../../src/tools/git/diff/output.ts";

const state: GitDiffSummaryCacheState = {
  repositoryIdentity: "/repo",
  workingDirectory: "/repo/packages/app",
  head: "head-a",
  dirtyFilesDigest: "dirty-a",
  staged: false,
  paths: ["src"],
  maxBytes: 16 * 1024,
};

const summary: GitDiffSummaryOutput = {
  mode: "summary",
  status: [{ path: "src/app.ts", indexStatus: " ", worktreeStatus: "M" }],
  stat: " src/app.ts | 1 +\n",
  hunks: [{ path: "src/app.ts", header: "@@ -1 +1 @@" }],
  output: { truncated: false, totalBytes: 1_024, totalLines: 1 },
  message: "complete summary",
};

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diskCache(root: string): ProjectCommandDiskJsonCache {
  return createProjectCommandDiskJsonCache({ rootDirectory: root }, isObject);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

it("keeps the no-environment cache process-local", async () => {
  const root = await mkdtemp(join(tmpdir(), "bash-tools-git-diff-cache-"));
  try {
    const first = createGitDiffSummaryCache({ diskCache: diskCache(root) });
    const second = createGitDiffSummaryCache({ diskCache: diskCache(root) });

    first.set(state, summary);

    expect(second.get(state)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects a bounded-summary record with a mismatched key or oversized status", async () => {
  vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
  vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
  const root = await mkdtemp(join(tmpdir(), "bash-tools-git-diff-cache-"));
  try {
    const cache = createGitDiffSummaryCache({ diskCache: diskCache(root) });
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

    await writeFile(
      join(directory, name),
      JSON.stringify({
        cacheFormatVersion: 1,
        key: "wrong-key",
        state,
        summary: {
          ...summary,
          status: Array.from({ length: 101 }, () => summary.status[0]),
        },
        flowId: "flow-a",
      }),
    );
    expect(cache.get(state)).toBeUndefined();

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

it("shares only an authorized flow snapshot and invalidates changed state", async () => {
  vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-a");
  vi.stubEnv("PI_ORCHESTRATION_EVIDENCE_SCOPE", "flow");
  const root = await mkdtemp(join(tmpdir(), "bash-tools-git-diff-cache-"));
  try {
    const first = createGitDiffSummaryCache({ diskCache: diskCache(root) });
    const second = createGitDiffSummaryCache({ diskCache: diskCache(root) });

    first.set(state, summary);

    expect(second.get(state)).toEqual(summary);
    expect(second.get({ ...state, dirtyFilesDigest: "dirty-b" })).toBeUndefined();

    vi.stubEnv("PI_ORCHESTRATION_FLOW", "flow-b");
    const otherFlow = createGitDiffSummaryCache({ diskCache: diskCache(root) });
    expect(otherFlow.get(state)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
