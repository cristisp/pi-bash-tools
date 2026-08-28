import { realpath, writeFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupProjectCommandFixtures, context, fixture } from "./tool-test-fixtures.ts";
import {
  projectCommandIdentity,
  type ProjectCommandDefinition,
} from "../../src/tools/project-command/definitions.ts";
import { resolveFixedProjectCommand } from "../../src/tools/project-command/resolution.ts";
import type { ProjectCommandRelevantInputDiscovery } from "../../src/tools/project-command/relevant-inputs.ts";
import { createProjectCommandToolForTesting } from "../../src/tools/project-command/tool.ts";
import { validateProjectCommandInput } from "../../src/tools/project-command/schema.ts";

const cacheDefinition = {
  namespace: "bash-tools.project-command",
  commandId: "cache_command",
  description: "A deterministic cache test command.",
  executable: "/bin/echo",
  args: ["cache"],
  cwdStrategy: "canonical-project",
  sanitizedEnvironmentProfile: "minimal-static-v1",
  processTimeoutMs: 30_000,
  outputLimitBytes: 50 * 1024,
  risk: "workspace-observation",
  globalSafe: true,
  reusePolicy: "project-metadata",
} satisfies ProjectCommandDefinition<"cache_command">;

const definitions = [cacheDefinition] as const;

afterEach(cleanupProjectCommandFixtures);

async function authorize(fixtureData: {
  readonly directory: string;
  readonly configPath: string;
}): Promise<{
  readonly projectPath: string;
  readonly resolved: ReturnType<typeof resolveFixedProjectCommand>;
}> {
  const projectPath = await realpath(fixtureData.directory);
  const resolved = resolveFixedProjectCommand(cacheDefinition);
  await writeFile(
    fixtureData.configPath,
    JSON.stringify({
      version: 2,
      environment: { version: 1 },
      projectCommands: {
        version: 1,
        global: { allow: [], deny: [] },
        projects: {
          [projectPath]: { allow: [projectCommandIdentity(cacheDefinition, resolved)], deny: [] },
        },
      },
    }),
  );
  return { projectPath, resolved };
}

function discovery(path?: string): ProjectCommandRelevantInputDiscovery {
  return {
    discover: async () => ({
      status: "complete",
      inputs: {
        files: path === undefined ? [] : [{ kind: "file", path }],
        values: [],
      },
    }),
  };
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

it("reuses an authorized deterministic result only within the same session", async () => {
  const fixtureData = await fixture();
  await authorize(fixtureData);
  const executor = vi.fn(async () => successOutcome("producer"));
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    definitions,
    executor,
    relevantInputDiscovery: discovery(),
  });
  const session = { getSessionId: () => "session-a" };

  const first = await tool.execute(
    "producer-call",
    { commandId: "cache_command" },
    undefined,
    undefined,
    context(fixtureData.directory, { sessionManager: session }),
  );
  const second = await tool.execute(
    "consumer-call",
    { commandId: "cache_command" },
    undefined,
    undefined,
    context(fixtureData.directory, { sessionManager: session }),
  );
  const otherSession = await tool.execute(
    "other-session-call",
    { commandId: "cache_command" },
    undefined,
    undefined,
    context(fixtureData.directory, { sessionManager: { getSessionId: () => "session-b" } }),
  );

  expect(executor).toHaveBeenCalledTimes(2);
  expect(first.details).toMatchObject({
    cacheDecision: "miss",
    reused: false,
    producerInvocationId: "producer-call",
    resultFingerprintVersion: 1,
  });
  expect(second.details).toMatchObject({
    cacheDecision: "hit",
    reused: true,
    toolCallId: "consumer-call",
    producerInvocationId: "producer-call",
    stdout: { text: "producer" },
  });
  expect(otherSession.details).toMatchObject({
    cacheDecision: "miss",
    reused: false,
    toolCallId: "other-session-call",
  });
});

it("validates and strips force without changing the result fingerprint", async () => {
  const fixtureData = await fixture();
  await authorize(fixtureData);
  const resolver = vi.fn(async (_definition, _projectPath, _signal, parameters) => {
    expect(parameters).toEqual({ commandId: "cache_command" });
    return resolveFixedProjectCommand(cacheDefinition);
  });
  const executor = vi.fn(async () => successOutcome("value"));
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    definitions,
    resolver,
    executor,
    relevantInputDiscovery: discovery(),
  });
  const ctx = context(fixtureData.directory, {
    sessionManager: { getSessionId: () => "session-force" },
  });

  const first = await tool.execute(
    "first",
    { commandId: "cache_command" },
    undefined,
    undefined,
    ctx,
  );
  const forced = await tool.execute(
    "forced",
    { commandId: "cache_command", force: true },
    undefined,
    undefined,
    ctx,
  );
  const after = await tool.execute(
    "after",
    { commandId: "cache_command" },
    undefined,
    undefined,
    ctx,
  );

  expect(executor).toHaveBeenCalledTimes(2);
  expect(first.details?.resultFingerprint).toBe(forced.details?.resultFingerprint);
  expect(forced.details).toMatchObject({ cacheDecision: "forced", forced: true, reused: false });
  expect(after.details).toMatchObject({
    cacheDecision: "hit",
    reused: true,
    producerInvocationId: "forced",
  });
  expect(() =>
    validateProjectCommandInput({ commandId: "cache_command", force: "yes" }, definitions),
  ).toThrow(/invalid/iu);
});

it("authorizes the current request before returning a cached result", async () => {
  const fixtureData = await fixture();
  await authorize(fixtureData);
  const executor = vi.fn(async () => successOutcome("value"));
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    definitions,
    executor,
    relevantInputDiscovery: discovery(),
  });
  const ctx = context(fixtureData.directory, {
    sessionManager: { getSessionId: () => "session-policy" },
  });

  await tool.execute("first", { commandId: "cache_command" }, undefined, undefined, ctx);
  const projectPath = await realpath(fixtureData.directory);
  await writeFile(
    fixtureData.configPath,
    JSON.stringify({
      version: 2,
      environment: { version: 1 },
      projectCommands: {
        version: 1,
        global: { allow: [], deny: [] },
        projects: {
          [projectPath]: {
            allow: [],
            deny: [
              projectCommandIdentity(cacheDefinition, resolveFixedProjectCommand(cacheDefinition)),
            ],
          },
        },
      },
    }),
  );

  await expect(
    tool.execute("denied", { commandId: "cache_command" }, undefined, undefined, ctx),
  ).rejects.toMatchObject({
    details: { category: "BLOCKED", cacheDecision: "ineligible" },
  });
  expect(executor).toHaveBeenCalledTimes(1);
});

it("invalidates a cached result when a relevant input changes", async () => {
  const fixtureData = await fixture();
  const inputPath = `${fixtureData.directory}/input.txt`;
  await writeFile(inputPath, "before");
  await authorize(fixtureData);
  const executor = vi.fn(async () => successOutcome("value"));
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    definitions,
    executor,
    relevantInputDiscovery: discovery("input.txt"),
  });
  const ctx = context(fixtureData.directory, {
    sessionManager: { getSessionId: () => "session-state" },
  });

  const first = await tool.execute(
    "first",
    { commandId: "cache_command" },
    undefined,
    undefined,
    ctx,
  );
  await writeFile(inputPath, "after");
  const invalidated = await tool.execute(
    "changed",
    { commandId: "cache_command" },
    undefined,
    undefined,
    ctx,
  );

  expect(executor).toHaveBeenCalledTimes(2);
  expect(invalidated.details).toMatchObject({
    cacheDecision: "invalidated",
    reused: false,
    producerInvocationId: "changed",
  });
  expect(invalidated.details?.resultFingerprint).not.toBe(first.details?.resultFingerprint);
  expect(invalidated.details).not.toHaveProperty("stateSnapshot");
  expect(invalidated.details).not.toHaveProperty("contentHash");
});

it("invalidates and evicts the prior logical entry when the manifest changes", async () => {
  const fixtureData = await fixture();
  await writeFile(`${fixtureData.directory}/input-a.txt`, "a");
  await writeFile(`${fixtureData.directory}/input-b.txt`, "b");
  await authorize(fixtureData);
  let includeB = false;
  const executor = vi.fn(async () => successOutcome(`run-${executor.mock.calls.length + 1}`));
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    definitions,
    executor,
    relevantInputDiscovery: {
      discover: async () => ({
        status: "complete" as const,
        inputs: {
          files: [
            { kind: "file" as const, path: "input-a.txt" },
            ...(includeB ? [{ kind: "file" as const, path: "input-b.txt" }] : []),
          ],
          values: [],
        },
      }),
    },
  });
  const ctx = context(fixtureData.directory, {
    sessionManager: { getSessionId: () => "session-manifest" },
  });

  await tool.execute("a", { commandId: "cache_command" }, undefined, undefined, ctx);
  includeB = true;
  const added = await tool.execute(
    "a-plus-b",
    { commandId: "cache_command" },
    undefined,
    undefined,
    ctx,
  );
  includeB = false;
  const removed = await tool.execute(
    "a-again",
    { commandId: "cache_command" },
    undefined,
    undefined,
    ctx,
  );

  expect(executor).toHaveBeenCalledTimes(3);
  expect(added.details).toMatchObject({ cacheDecision: "invalidated", reused: false });
  expect(removed.details).toMatchObject({ cacheDecision: "invalidated", reused: false });
});
