import { readFile, realpath, writeFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  getProjectCommandDefinition,
  projectCommandIdentity,
} from "../../src/tools/project-command/definitions.ts";
import { resolveFixedProjectCommand } from "../../src/tools/project-command/resolution.ts";
import { createPolicyStoreForTesting } from "../../src/tools/policy/store.ts";
import type { PolicyStore } from "../../src/tools/policy/types.ts";
import {
  cleanupProjectCommandFixtures,
  context,
  fixture,
  successExecutor,
} from "./tool-test-fixtures.ts";
import { createProjectCommandToolForTesting } from "../../src/tools/project-command/tool.ts";

afterEach(cleanupProjectCommandFixtures);

it("reports a dismissed confirmation as an abort cancellation", async () => {
  const fixtureData = await fixture();
  const tool = createProjectCommandToolForTesting({ configPath: fixtureData.configPath });
  const execution = tool.execute(
    "1",
    { commandId: "workspace_path" },
    undefined,
    undefined,
    context(fixtureData.directory, {
      mode: "tui",
      hasUI: true,
      ui: { select: async () => undefined },
    }),
  );
  await expect(execution).rejects.toMatchObject({
    message: "Project command request cancelled",
    name: "AbortError",
    contract: {
      code: "cancelled",
      category: "CANCELLED",
      retryable: true,
      executed: false,
    },
    details: {
      category: "CANCELLED",
      executed: false,
      toolCallId: "1",
      reused: false,
      durationMs: expect.any(Number),
      executionDurationMs: 0,
      suggestedAction: "Retry the request if the command is still needed.",
    },
  });
  expect(JSON.parse(await readFile(fixtureData.configPath, "utf8"))).toEqual({ version: 1 });
});

it("preserves cancellation when policy loading fails after abort", async () => {
  const fixtureData = await fixture();
  const controller = new AbortController();
  const policy: PolicyStore = {
    configPath: fixtureData.configPath,
    load: async () => {
      controller.abort();
      throw new Error("policy load failed");
    },
    recordDecisions: async () => undefined,
  };
  const tool = createProjectCommandToolForTesting({ policy });
  await expect(
    tool.execute(
      "1",
      { commandId: "workspace_path" },
      controller.signal,
      undefined,
      context(fixtureData.directory),
    ),
  ).rejects.toMatchObject({
    message: "Project command request cancelled",
    name: "AbortError",
    details: {
      category: "CANCELLED",
      executed: false,
      toolCallId: "1",
      reused: false,
      durationMs: expect.any(Number),
      executionDurationMs: 0,
      suggestedAction: "Retry the request if the command is still needed.",
      error: {
        category: "CANCELLED",
        suggestedAction: "Retry the request if the command is still needed.",
      },
    },
  });
});

it("classifies a persisted policy denial as blocked without execution", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("workspace_path");
  if (definition === undefined) throw new Error("missing workspace_path definition");
  const resolved = resolveFixedProjectCommand(definition);
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
            deny: [projectCommandIdentity(definition, resolved)],
          },
        },
      },
    }),
  );
  const executor = successExecutor();
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    executor,
  });
  await expect(
    tool.execute(
      "1",
      { commandId: "workspace_path" },
      undefined,
      undefined,
      context(fixtureData.directory),
    ),
  ).rejects.toMatchObject({
    contract: {
      code: "policy-denied",
      category: "BLOCKED",
      retryable: false,
      executed: false,
    },
    details: {
      category: "BLOCKED",
      executed: false,
      toolCallId: "1",
      reused: false,
      durationMs: expect.any(Number),
      executionDurationMs: 0,
      suggestedAction:
        "Request authorization or adjust the project command policy before retrying.",
    },
  });
  expect(executor).not.toHaveBeenCalled();
});

it("maps non-cancellation policy load failures", async () => {
  const fixtureData = await fixture();
  const policy: PolicyStore = {
    configPath: fixtureData.configPath,
    load: async () => {
      throw new Error("policy load failed");
    },
    recordDecisions: async () => undefined,
  };
  const tool = createProjectCommandToolForTesting({ policy });
  await expect(
    tool.execute(
      "1",
      { commandId: "workspace_path" },
      undefined,
      undefined,
      context(fixtureData.directory),
    ),
  ).rejects.toMatchObject({
    message: "Unable to load project command policy",
    name: "ProjectCommandToolError",
    contract: {
      code: "policy-load-failure",
      category: "POLICY_FAILURE",
      retryable: true,
      executed: false,
    },
    details: {
      category: "POLICY_FAILURE",
      executed: false,
      toolCallId: "1",
      reused: false,
      durationMs: expect.any(Number),
      executionDurationMs: 0,
      suggestedAction: "Review the project command policy configuration, then retry the request.",
      error: {
        category: "POLICY_FAILURE",
        suggestedAction: "Review the project command policy configuration, then retry the request.",
      },
    },
  });
});

it("uses exactly the authorization choices and persists an allow decision before execution", async () => {
  const fixtureData = await fixture();
  const choices: string[] = [];
  const select = vi.fn(async (_title: string, options: string[]) => {
    choices.push(...options);
    return "Allow for this project";
  });
  const executor = successExecutor();
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    executor,
  });
  const response = await tool.execute(
    "1",
    { commandId: "workspace_path" },
    undefined,
    undefined,
    context(fixtureData.directory, { mode: "tui", hasUI: true, ui: { select } }),
  );
  expect(response.details).toMatchObject({
    status: "success",
    category: "PASS",
    executed: true,
  });
  expect(choices).toEqual([
    "Deny once",
    "Deny for this project",
    "Allow once",
    "Allow for this project",
  ]);
  expect(executor).toHaveBeenCalledWith(
    expect.objectContaining({
      definition: expect.objectContaining({ commandId: "workspace_path" }),
      executable: "/bin/pwd",
      args: [],
    }),
    await realpath(fixtureData.directory),
    undefined,
  );
  expect(JSON.parse(await readFile(fixtureData.configPath, "utf8"))).toMatchObject({
    version: 2,
    projectCommands: { version: 1 },
  });
});

it("records a project deny on confirmation timeout", async () => {
  const fixtureData = await fixture({ version: 1, confirmationTimeoutMs: 1 });
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    executor: successExecutor(),
  });
  await expect(
    tool.execute(
      "1",
      { commandId: "node_version" },
      undefined,
      undefined,
      context(fixtureData.directory, {
        mode: "rpc",
        hasUI: true,
        ui: { select: () => new Promise<string | undefined>(() => undefined) },
      }),
    ),
  ).rejects.toMatchObject({
    message: expect.stringMatching(/timed out/iu),
    contract: {
      code: "confirmation-timeout",
      category: "TIMEOUT",
      retryable: true,
      executed: false,
    },
    details: {
      category: "TIMEOUT",
      executed: false,
      toolCallId: "1",
      reused: false,
      durationMs: expect.any(Number),
      executionDurationMs: 0,
      suggestedAction: "Review the command duration and project state before retrying the request.",
      error: {
        category: "TIMEOUT",
        suggestedAction:
          "Review the command duration and project state before retrying the request.",
      },
    },
  });
  expect(JSON.parse(await readFile(fixtureData.configPath, "utf8"))).toMatchObject({
    version: 2,
    projectCommands: {
      projects: {
        [await realpath(fixtureData.directory)]: { deny: [{ commandId: "node_version" }] },
      },
    },
  });
});

it("does not persist a decision when cancellation happens before persistence", async () => {
  const fixtureData = await fixture();
  const controller = new AbortController();
  const tool = createProjectCommandToolForTesting({ configPath: fixtureData.configPath });
  const request = tool.execute(
    "1",
    { commandId: "workspace_path" },
    controller.signal,
    undefined,
    context(fixtureData.directory, {
      mode: "tui",
      hasUI: true,
      ui: {
        select: async () => {
          controller.abort();
          return "Allow for this project";
        },
      },
    }),
  );
  await expect(request).rejects.toMatchObject({ name: "AbortError" });
  expect(JSON.parse(await readFile(fixtureData.configPath, "utf8"))).toEqual({ version: 1 });
});

it("does not execute after a committed decision is followed by cancellation", async () => {
  const fixtureData = await fixture();
  const base = createPolicyStoreForTesting({ configPath: fixtureData.configPath });
  const controller = new AbortController();
  const policy: PolicyStore = {
    configPath: base.configPath,
    load: (cwd) => base.load(cwd),
    recordDecisions: async (projectPath, decisions, signal) => {
      await base.recordDecisions(projectPath, decisions, signal);
      controller.abort();
    },
  };
  const executor = successExecutor();
  const tool = createProjectCommandToolForTesting({ policy, executor });
  await expect(
    tool.execute(
      "1",
      { commandId: "workspace_path" },
      controller.signal,
      undefined,
      context(fixtureData.directory, {
        mode: "tui",
        hasUI: true,
        ui: { select: async () => "Allow for this project" },
      }),
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(executor).not.toHaveBeenCalled();
});
