import { readFile, realpath, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createProjectCommandToolForTesting } from "./tool.ts";
import { createPolicyStoreForTesting } from "../policy/store.ts";
import type { PolicyStore } from "../policy/types.ts";
import {
  getProjectCommandDefinition,
  getProjectCommandDefinitions,
  projectCommandIdentity,
  type ProjectCommandDefinition,
} from "./definitions.ts";
import type { ProjectCommandToolContext } from "./tool.ts";
import {
  ProjectCommandResolutionError,
  resolveFixedProjectCommand,
  type ResolvedProjectCommand,
} from "./resolution.ts";
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
  return vi.fn(async (_resolved: ResolvedProjectCommand, cwd: string) => ({
    status: "success" as const,
    exit: { code: 0, signal: null },
    timedOut: false,
    cancelled: false,
    stdout: { text: cwd, truncated: false, totalBytes: cwd.length, totalLines: 1 },
    stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
  }));
}

describe("project command tool authorization", () => {
  it("keeps resolution failures outside authorization and execution failure mapping", async () => {
    const fixtureData = await fixture();
    const executor = successExecutor();
    const resolutionError = new ProjectCommandResolutionError(
      "binary-resolution",
      "missing-binary",
    );
    const tool = createProjectCommandToolForTesting({
      configPath: fixtureData.configPath,
      executor,
      resolver: async () => {
        throw resolutionError;
      },
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
      name: "ProjectCommandToolError",
      message: expect.stringMatching(
        /commandId: workspace_path.*stage: binary-resolution.*code: missing-binary.*not attempted/u,
      ),
      details: {
        status: "resolution-failure",
        executed: false,
        commandId: "workspace_path",
        requestedParameters: { commandId: "workspace_path" },
        stage: "binary-resolution",
        code: "missing-binary",
        resolutionDetails: resolutionError.details,
      },
    });
    expect(executor).not.toHaveBeenCalled();
  });

  it("passes the resolved command shape through authorization and execution", async () => {
    const fixtureData = await fixture();
    const definition = getProjectCommandDefinition("workspace_path");
    if (definition === undefined) {
      throw new Error("missing workspace_path definition");
    }
    const resolved = {
      ...resolveFixedProjectCommand(definition),
      executable: "/bin/echo",
      args: ["resolved"],
    } satisfies ResolvedProjectCommand;
    const projectPath = await realpath(fixtureData.directory);
    const identity = projectCommandIdentity(definition, resolved);
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
    const executor = successExecutor();
    const tool = createProjectCommandToolForTesting({
      configPath: fixtureData.configPath,
      executor,
      resolver: async () => resolved,
    });

    await tool.execute(
      "1",
      { commandId: "workspace_path" },
      undefined,
      undefined,
      context(fixtureData.directory),
    );
    expect(executor).toHaveBeenCalledWith(resolved, projectPath, undefined);
  });

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
    });
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
    });
  });

  it("captures injected definitions for schema, validation, and dispatch", async () => {
    const fixtureData = await fixture();
    const customDefinition = {
      namespace: "bash-tools.project-command",
      commandId: "custom_command",
      description: "Run the custom command.",
      executable: "/bin/echo",
      args: ["custom"],
      cwdStrategy: "canonical-project",
      sanitizedEnvironmentProfile: "minimal-static-v1",
      processTimeoutMs: 30_000,
      outputLimitBytes: 50 * 1024,
      risk: "workspace-observation",
      globalSafe: true,
    } satisfies ProjectCommandDefinition<"custom_command">;
    const injectedDefinitions: ProjectCommandDefinition[] = [customDefinition];
    const executor = successExecutor();
    const tool = createProjectCommandToolForTesting({
      configPath: fixtureData.configPath,
      definitions: injectedDefinitions,
      executor,
    });
    injectedDefinitions.push(getProjectCommandDefinitions()[0]);
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
            [projectPath]: { allow: [projectCommandIdentity(customDefinition)], deny: [] },
          },
        },
      }),
    );

    expect(JSON.stringify(tool.parameters)).toContain('"custom_command"');
    expect(JSON.stringify(tool.parameters)).not.toContain("workspace_path");
    const response = await tool.execute(
      "custom",
      { commandId: "custom_command" },
      undefined,
      undefined,
      context(fixtureData.directory),
    );
    expect(response.details).toMatchObject({ commandId: "custom_command", status: "success" });
    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({ definition: customDefinition }),
      projectPath,
      undefined,
    );
    await expect(
      tool.execute(
        "workspace",
        { commandId: "workspace_path" },
        undefined,
        undefined,
        context(fixtureData.directory),
      ),
    ).rejects.toThrow(/invalid/iu);
  });

  it("rejects duplicate injected command IDs", () => {
    const definition = getProjectCommandDefinitions()[0];
    if (definition === undefined) {
      throw new Error("missing workspace_path definition");
    }

    expect(() =>
      createProjectCommandToolForTesting({
        configPath: "/tmp/project-command-duplicate-policy.json",
        definitions: [definition, definition],
      }),
    ).toThrow(/duplicate/iu);
  });

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

  it("returns Fallow findings with exit code one as normal command data", async () => {
    const fixtureData = await fixture();
    const definition = getProjectCommandDefinition("fallow_health");
    if (definition === undefined) throw new Error("missing fallow_health definition");
    const resolved = {
      ...resolveFixedProjectCommand(definition),
      executable: process.execPath,
      args: ["/project/node_modules/fallow/bin/fallow", ...definition.args],
      fingerprintArgs: definition.argvTemplate,
    } satisfies ResolvedProjectCommand;
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
            [projectPath]: { allow: [projectCommandIdentity(definition, resolved)], deny: [] },
          },
        },
      }),
    );
    const tool = createProjectCommandToolForTesting({
      configPath: fixtureData.configPath,
      resolver: async () => resolved,
      executor: async () => ({
        status: "nonzero" as const,
        exit: { code: 1, signal: null },
        timedOut: false,
        cancelled: false,
        stdout: {
          text: '{"kind":"health","findings":[{}]}',
          truncated: false,
          totalBytes: 34,
          totalLines: 1,
        },
        stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
      }),
    });
    const response = await tool.execute(
      "fallow-health",
      { commandId: "fallow_health" },
      undefined,
      undefined,
      context(fixtureData.directory),
    );
    expect(response.details).toMatchObject({
      commandId: "fallow_health",
      status: "nonzero",
      exit: { code: 1, signal: null },
      stdout: { text: '{"kind":"health","findings":[{}]}' },
      resolvedCommand: expect.stringContaining("health --format json --quiet"),
      parameters: {},
    });
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining('"resolvedCommand":"'),
    });
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining('"parameters":{}'),
    });
  });

  it("keeps exit code two as a Fallow execution failure", async () => {
    const fixtureData = await fixture();
    const definition = getProjectCommandDefinition("fallow_health");
    if (definition === undefined) throw new Error("missing fallow_health definition");
    const resolved = {
      ...resolveFixedProjectCommand(definition),
      executable: process.execPath,
      args: ["/project/node_modules/fallow/bin/fallow", ...definition.args],
      fingerprintArgs: definition.argvTemplate,
    } satisfies ResolvedProjectCommand;
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
            [projectPath]: { allow: [projectCommandIdentity(definition, resolved)], deny: [] },
          },
        },
      }),
    );
    const tool = createProjectCommandToolForTesting({
      configPath: fixtureData.configPath,
      resolver: async () => resolved,
      executor: async () => ({
        status: "nonzero" as const,
        exit: { code: 2, signal: null },
        timedOut: false,
        cancelled: false,
        stdout: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
        stderr: { text: "invalid options", truncated: false, totalBytes: 15, totalLines: 1 },
      }),
    });
    await expect(
      tool.execute(
        "fallow-health",
        { commandId: "fallow_health" },
        undefined,
        undefined,
        context(fixtureData.directory),
      ),
    ).rejects.toMatchObject({
      message: expect.stringMatching(
        /status: nonzero.*commandId: fallow_health.*resolvedCommand: .*health --format json --quiet.*parameters: \{\}.*exit: code 2.*stderr: "invalid options"/u,
      ),
      details: {
        commandId: "fallow_health",
        status: "nonzero",
        resolvedCommand: expect.stringContaining("health --format json --quiet"),
        parameters: {},
        exit: { code: 2, signal: null },
        stderr: { text: "invalid options" },
      },
    });
  });

  it("includes timeout diagnostics with resolved parameters and stdout fallback", async () => {
    const fixtureData = await fixture();
    const definition = getProjectCommandDefinition("fallow_audit");
    if (definition === undefined) throw new Error("missing fallow_audit definition");
    const resolved = {
      ...resolveFixedProjectCommand(definition),
      executable: "/bin/fallow",
      args: ["audit", "--format", "json", "--quiet", "--base", "HEAD~1"],
      effectiveParameters: { base: "HEAD~1" },
    } satisfies ResolvedProjectCommand;
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
            [projectPath]: { allow: [projectCommandIdentity(definition, resolved)], deny: [] },
          },
        },
      }),
    );
    const tool = createProjectCommandToolForTesting({
      configPath: fixtureData.configPath,
      resolver: async () => resolved,
      executor: async () => ({
        status: "timeout" as const,
        exit: { code: null, signal: "SIGTERM" },
        timedOut: true,
        cancelled: false,
        stdout: { text: "diagnostic output", truncated: false, totalBytes: 16, totalLines: 1 },
        stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
      }),
    });
    await expect(
      tool.execute(
        "fallow-audit",
        { commandId: "fallow_audit", base: "HEAD~1" },
        undefined,
        undefined,
        context(fixtureData.directory),
      ),
    ).rejects.toMatchObject({
      message: expect.stringMatching(
        /status: timeout.*reason: the command timed out.*commandId: fallow_audit.*resolvedCommand: \/bin\/fallow audit --format json --quiet --base HEAD~1.*parameters: \{"base":"HEAD~1"\}.*exit: signal SIGTERM.*stdout: "diagnostic output"/u,
      ),
      details: {
        status: "timeout",
        commandId: "fallow_audit",
        resolvedCommand: "/bin/fallow audit --format json --quiet --base HEAD~1",
        parameters: { base: "HEAD~1" },
        exit: { code: null, signal: "SIGTERM" },
        stdout: { text: "diagnostic output" },
      },
    });
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
