import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import type { PolicyStore } from "../../src/tools/policy/types.ts";
import type { ProjectCommandExecutionOutcome } from "../../src/tools/project-command/execution.ts";
import type { ProjectCommandExecutor } from "../../src/tools/project-command/runner.ts";
import type { ProjectCommandResolver } from "../../src/tools/project-command/resolution.ts";
import { createProjectCommandExecutor } from "../../src/tools/project-command/execution.ts";
import { resolveNodeProjectCommand } from "../../src/tools/project-command/node.ts";
import { createProjectCommandRepositoryStateReader } from "../../src/tools/project-command/repository-state.ts";
import {
  BASH_TOOLS_INVOCATIONS_PATH,
  createProjectCommandInvocationRecorder,
} from "../../src/observability/project-command-invocation.ts";
import { createVerifyEvidenceCache } from "../../src/tools/verify/cache.ts";
import { createVerifyToolForTesting, type VerifyToolContext } from "../../src/tools/verify/tool.ts";
import {
  createGitIntegrationFixtures,
  gitIntegration,
  makeRealGitExec,
  rawGit,
} from "../git/integration-fixtures.ts";

const fixtures = createGitIntegrationFixtures();

afterEach(() => fixtures.cleanup());

function policy(): PolicyStore {
  return {
    configPath: "test-policy",
    load: async (cwd) => ({
      projectPath: await realpath(cwd),
      confirmationTimeoutMs: 1000,
      document: {
        version: 2,
        environment: {
          version: 1,
          confirmationTimeoutMs: 1000,
          global: { allow: [], deny: [] },
          projects: {},
        },
        projectCommands: {
          version: 1,
          global: { allow: [], deny: [] },
          projects: {},
        },
      },
    }),
    recordDecisions: async () => undefined,
  };
}

function context(cwd: string): VerifyToolContext {
  return {
    cwd,
    mode: "tui",
    hasUI: true,
    signal: undefined,
    ui: { select: async () => "Allow once" },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(line: string): Record<string, unknown> {
  const value: unknown = JSON.parse(line);
  if (isRecord(value)) return value;
  throw new Error("expected a JSON object invocation record");
}

function outcome(): ProjectCommandExecutionOutcome {
  return {
    status: "success",
    exit: { code: 0, signal: null },
    timedOut: false,
    cancelled: false,
    executed: true,
    stdout: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
    stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
  };
}

function dependencies(onFirstExecution?: () => Promise<void>) {
  const resolver: ProjectCommandResolver = async (definition) => ({
    definition,
    executable: "pnpm",
    args: ["run", definition.fixedScriptKey ?? "unknown"],
    displayCommand: `pnpm run ${definition.fixedScriptKey ?? "unknown"}`,
    effectiveParameters: Object.freeze({}),
    scriptHash: `hash-${definition.fixedScriptKey ?? "unknown"}`,
    scriptKey: definition.fixedScriptKey,
  });
  let executionCount = 0;
  const executor = vi.fn<ProjectCommandExecutor>(async () => {
    executionCount += 1;
    if (executionCount === 1) await onFirstExecution?.();
    return outcome();
  });
  return { executor, resolver };
}

gitIntegration("Verify repository-state cache invalidation", () => {
  it("writes a producer JSONL record for execution and each lookup outcome", async () => {
    const repository = await fixtures.createRepository();
    await writeFile(
      join(repository.directory, "package.json"),
      JSON.stringify({
        packageManager: "npm@10.0.0",
        scripts: {
          "format:check": 'node -e "process.exit(0)"',
          lint: 'node -e "process.exit(0)"',
          test: 'node -e "process.exit(0)"',
        },
      }),
    );
    await rawGit(repository.directory, ["add", "package.json"]);
    await rawGit(repository.directory, ["commit", "--quiet", "-m", "project manifest"]);
    const streamRoot = await mkdtemp(join(tmpdir(), "bash-tools-invocation-stream-"));
    fixtures.trackDirectory(streamRoot);
    const streamPath = join(streamRoot, "invocations.jsonl");
    const cacheRoot = await mkdtemp(join(tmpdir(), "bash-tools-verify-cache-"));
    fixtures.trackDirectory(cacheRoot);
    try {
      const resolver: ProjectCommandResolver = (definition, projectPath, _signal, parameters) =>
        resolveNodeProjectCommand(definition, projectPath, parameters, {
          approvedPackageManagerDirectories: [dirname(process.execPath)],
        });
      const invocationRecorder = createProjectCommandInvocationRecorder(
        { appendEntry: vi.fn() },
        { [BASH_TOOLS_INVOCATIONS_PATH]: streamPath },
      );
      const tool = createVerifyToolForTesting({
        policy: policy(),
        resolver,
        executor: createProjectCommandExecutor(),
        repositoryStateReader: createProjectCommandRepositoryStateReader(makeRealGitExec()),
        cache: createVerifyEvidenceCache({ rootDirectory: cacheRoot }),
        invocationRecorder,
      });
      const first = await tool.execute(
        "verify-stream-execution",
        { omit: ["typecheck"] },
        undefined,
        undefined,
        context(repository.directory),
      );
      expect(first.details.ref).toBeDefined();
      const reused = await tool.execute(
        "verify-stream-reuse",
        { omit: ["typecheck"] },
        undefined,
        undefined,
        context(repository.directory),
      );
      expect(reused.details.reused).toBe(true);
      await tool.execute(
        "verify-stream-lookup",
        { ref: first.details.ref },
        undefined,
        undefined,
        context(repository.directory),
      );
      await expect(
        tool.execute(
          "verify-stream-missing-lookup",
          { ref: "vr_missing_stream" },
          undefined,
          undefined,
          context(repository.directory),
        ),
      ).rejects.toMatchObject({ code: "not-found" });
      const noReusableTool = createVerifyToolForTesting({
        policy: policy(),
        resolver,
        executor: createProjectCommandExecutor(),
        repositoryStateReader: async () => undefined,
        invocationRecorder,
      });
      const noReusable = await noReusableTool.execute(
        "verify-stream-no-ref",
        { omit: ["typecheck"] },
        undefined,
        undefined,
        context(repository.directory),
      );
      expect(noReusable.details.ref).toBeUndefined();

      const records = (await readFile(streamPath, "utf8")).trimEnd().split("\n").map(parseRecord);
      expect(records).toHaveLength(5);
      expect(records.every((record) => record.commandId === "verify")).toBe(true);
      expect(records[0]).toMatchObject({
        executed: true,
        reused: false,
        aggregate: true,
      });
      expect(records[1]).toMatchObject({ executed: false, reused: true });
      expect(records[1]).not.toHaveProperty("lookup");
      expect(records[2]).toMatchObject({
        lookup: { attempted: true, success: true },
        repositoryState: { readable: true, stateMatchesCurrent: true },
      });
      expect(records[3]).toMatchObject({
        executed: false,
        lookup: { attempted: true, success: false, failure: "not-found" },
        reason: "lookup-failure",
        resultCategory: "RESOLUTION_FAILURE",
      });
      expect(records[4]).toMatchObject({
        executed: true,
        reused: false,
        cacheDecision: "ineligible",
      });
      expect(records[4]).not.toHaveProperty("ref");
    } finally {
      await Promise.all([
        rm(streamRoot, { recursive: true, force: true }),
        rm(cacheRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it("reuses the shared cache and reruns after tracked and untracked content changes", async () => {
    const repository = await fixtures.createRepository();
    await writeFile(join(repository.directory, "package.json"), JSON.stringify({ scripts: {} }));
    await rawGit(repository.directory, ["add", "package.json"]);
    await rawGit(repository.directory, ["commit", "--quiet", "-m", "project manifest"]);
    const trackedPath = join(repository.directory, "package.json");
    const dirtyPath = join(repository.directory, "README.md");
    await writeFile(trackedPath, JSON.stringify({ scripts: {}, marker: "one" }));
    await writeFile(dirtyPath, "untracked content one\n");
    const repositoryStateReader = createProjectCommandRepositoryStateReader(makeRealGitExec());
    const firstState = await repositoryStateReader(repository.directory, undefined);
    expect(firstState).toBeDefined();

    // One cache is shared by every tool instance so reuse and invalidation are observed together.
    const cache = createVerifyEvidenceCache();
    const input = { omit: ["typecheck"] as const };

    const firstDeps = dependencies();
    const firstTool = createVerifyToolForTesting({
      policy: policy(),
      resolver: firstDeps.resolver,
      executor: firstDeps.executor,
      repositoryStateReader,
      cache,
    });
    const first = await firstTool.execute(
      "verify-content-1",
      input,
      undefined,
      undefined,
      context(repository.directory),
    );
    expect(first.details.status).toBe("completed");
    expect(first.details.reused).toBe(false);
    expect(first.details.ref).toBeDefined();
    expect(firstDeps.executor).toHaveBeenCalledTimes(3);

    // Unchanged repository state on the shared cache must reuse the persisted evidence.
    const reusedDeps = dependencies();
    const reusedTool = createVerifyToolForTesting({
      policy: policy(),
      resolver: reusedDeps.resolver,
      executor: reusedDeps.executor,
      repositoryStateReader,
      cache,
    });
    const reused = await reusedTool.execute(
      "verify-content-2",
      input,
      undefined,
      undefined,
      context(repository.directory),
    );
    expect(reused.details.status).toBe("unchanged");
    expect(reused.details.reused).toBe(true);
    expect(reused.details.ref).toBe(first.details.ref);
    expect(reusedDeps.executor).toHaveBeenCalledTimes(0);

    await writeFile(trackedPath, JSON.stringify({ scripts: {}, marker: "two" }));
    await writeFile(dirtyPath, "untracked content two\n");
    const secondState = await repositoryStateReader(repository.directory, undefined);
    expect(secondState).toBeDefined();
    expect(secondState?.dirtyFilesDigest).not.toBe(firstState?.dirtyFilesDigest);

    const secondDeps = dependencies();
    const secondTool = createVerifyToolForTesting({
      policy: policy(),
      resolver: secondDeps.resolver,
      executor: secondDeps.executor,
      repositoryStateReader,
      cache,
    });
    const second = await secondTool.execute(
      "verify-content-3",
      input,
      undefined,
      undefined,
      context(repository.directory),
    );
    expect(second.details.status).toBe("completed");
    expect(second.details.reused).toBe(false);
    expect(second.details.ref).not.toBe(first.details.ref);
    expect(secondDeps.executor).toHaveBeenCalledTimes(3);
  });

  it("does not persist evidence when content changes during execution", async () => {
    const repository = await fixtures.createRepository();
    await writeFile(join(repository.directory, "package.json"), JSON.stringify({ scripts: {} }));
    await rawGit(repository.directory, ["add", "package.json"]);
    await rawGit(repository.directory, ["commit", "--quiet", "-m", "project manifest"]);
    const dirtyPath = join(repository.directory, "README.md");
    const initialContent = "dirty content one\n";
    await writeFile(dirtyPath, initialContent);

    const firstDeps = dependencies(async () => {
      await writeFile(dirtyPath, "content changed during execution\n");
    });
    const tool = createVerifyToolForTesting({
      policy: policy(),
      resolver: firstDeps.resolver,
      executor: firstDeps.executor,
      repositoryStateReader: createProjectCommandRepositoryStateReader(makeRealGitExec()),
    });
    const input = { omit: ["typecheck"] as const };
    const first = await tool.execute(
      "verify-execution-race-1",
      input,
      undefined,
      undefined,
      context(repository.directory),
    );
    expect(first.details.status).toBe("completed");
    expect(first.details.reused).toBe(false);
    expect(firstDeps.executor).toHaveBeenCalledTimes(3);

    await writeFile(dirtyPath, initialContent);
    const second = await tool.execute(
      "verify-execution-race-2",
      input,
      undefined,
      undefined,
      context(repository.directory),
    );
    expect(second.details.status).toBe("completed");
    expect(second.details.reused).toBe(false);
    expect(firstDeps.executor).toHaveBeenCalledTimes(6);
  });
});
