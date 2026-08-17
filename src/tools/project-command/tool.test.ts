import { readFile, realpath, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createProjectCommandToolForTesting } from "./tool.ts";
import {
  createProjectCommandPolicyStoreForTesting,
  type ProjectCommandPolicyStore,
} from "./policy.ts";
import { getProjectCommandDefinition, projectCommandIdentity } from "./definitions.ts";
import type { ProjectCommandToolContext } from "./tool.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const directories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function context(
  cwd: string,
  overrides: Partial<ProjectCommandToolContext> = {},
): ProjectCommandToolContext {
  return {
    cwd,
    mode: "print",
    hasUI: false,
    signal: undefined,
    ui: { select: async () => undefined },
    ...overrides,
  };
}

async function fixture(
  value: unknown = { version: 1 },
): Promise<{ directory: string; configPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "bash-tools-project-command-tool-"));
  directories.push(directory);
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify(value));
  return { directory, configPath };
}

function successExecutor() {
  return vi.fn(
    async (
      _definition: NonNullable<ReturnType<typeof getProjectCommandDefinition>>,
      cwd: string,
    ) => ({
      status: "success" as const,
      exit: { code: 0, signal: null },
      timedOut: false,
      cancelled: false,
      stdout: { text: cwd, truncated: false, totalBytes: cwd.length, totalLines: 1 },
      stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
    }),
  );
}

describe("project command tool authorization", () => {
  it("rejects unknown commands without UI and leaves policy unchanged", async () => {
    const fixtureData = await fixture();
    const tool = createProjectCommandToolForTesting({ configPath: fixtureData.configPath });
    await expect(
      tool.execute(
        "1",
        { commandId: "workspace_path" },
        undefined,
        undefined,
        context(fixtureData.directory),
      ),
    ).rejects.toThrow(/not authorized/iu);
    expect(JSON.parse(await readFile(fixtureData.configPath, "utf8"))).toEqual({ version: 1 });
  });

  it("uses exactly the existing choices and persists an allow decision before execution", async () => {
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
    expect(response.details.status).toBe("success");
    expect(choices).toEqual([
      "Deny globally",
      "Deny for this project",
      "Allow globally",
      "Allow for this project",
    ]);
    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: "workspace_path" }),
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
    ).rejects.toThrow(/timed out/iu);
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
    const base = createProjectCommandPolicyStoreForTesting({ configPath: fixtureData.configPath });
    const controller = new AbortController();
    const policy: ProjectCommandPolicyStore = {
      configPath: base.configPath,
      load: (cwd) => base.load(cwd),
      recordDecision: async (projectPath, identity, decision, signal, globalSafe) => {
        await base.recordDecision(projectPath, identity, decision, signal, globalSafe);
        controller.abort();
      },
      recordDecisions: (projectPath, decisions, signal) =>
        base.recordDecisions(projectPath, decisions, signal),
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

  it("returns bounded execution details and marks execution cancellation as abort", async () => {
    const fixtureData = await fixture();
    const identity = projectCommandIdentity(getProjectCommandDefinition("workspace_path")!);
    const projectPath = await realpath(fixtureData.directory);
    await writeFile(
      fixtureData.configPath,
      JSON.stringify({
        version: 2,
        environment: { version: 1 },
        projectCommands: {
          version: 1,
          global: { allow: [], deny: [] },
          projects: { [projectPath]: { allow: [identity], deny: [] } },
        },
      }),
    );
    const tool = createProjectCommandToolForTesting({
      configPath: fixtureData.configPath,
      executor: async () => ({
        status: "cancelled" as const,
        exit: { code: null, signal: "SIGTERM" },
        timedOut: false,
        cancelled: true,
        stdout: { text: "partial", truncated: true, totalBytes: 100, totalLines: 2 },
        stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
      }),
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
      name: "AbortError",
      details: { commandId: "workspace_path", cancelled: true },
    });
  });
});
