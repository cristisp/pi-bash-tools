import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectCommandToolForTesting } from "../src/tools/project-command/tool.ts";
import {
  getProjectCommandDefinitions,
  getProjectCommandDefinition,
  projectCommandIdentity,
} from "../src/tools/project-command/definitions.ts";
import { resolveNodeProjectCommand } from "../src/tools/project-command/node.ts";
import { resolveProjectCommand } from "../src/tools/project-command/resolution.ts";
import { createNodeProjectIntegrationFixture } from "./node-project.integration-fixtures.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("project command integration", () => {
  it("runs every practical catalog command against a real temporary fixture project", async () => {
    const fixture = await createNodeProjectIntegrationFixture();
    const userAgent = await mkdtemp(join(tmpdir(), "bash-tools-node-project-integration-policy-"));
    directories.push(fixture.directory, userAgent);
    const requests = [
      { commandId: "workspace_path", params: { commandId: "workspace_path" } },
      { commandId: "node_version", params: { commandId: "node_version" } },
      { commandId: "node_project_info", params: { commandId: "node_project_info" } },
      { commandId: "node_deps_list", params: { commandId: "node_deps_list" } },
      {
        commandId: "node_test",
        params: { commandId: "node_test", paths: ["fixture-runner.js"] },
      },
      { commandId: "node_build", params: { commandId: "node_build" } },
      { commandId: "node_lint", params: { commandId: "node_lint" } },
      { commandId: "node_typecheck", params: { commandId: "node_typecheck" } },
      { commandId: "fallow_dead_code", params: { commandId: "fallow_dead_code" } },
      { commandId: "fallow_dupes", params: { commandId: "fallow_dupes" } },
      { commandId: "fallow_health", params: { commandId: "fallow_health" } },
      { commandId: "fallow_audit", params: { commandId: "fallow_audit", base: "HEAD~1" } },
      {
        commandId: "fallow_list_entry_points",
        params: { commandId: "fallow_list_entry_points" },
      },
      { commandId: "fallow_list_boundaries", params: { commandId: "fallow_list_boundaries" } },
    ] as const;
    const identities = await Promise.all(
      requests.map(async (request) => {
        const definition = getProjectCommandDefinition(request.commandId);
        if (definition === undefined) throw new Error(`missing ${request.commandId} definition`);
        const resolved = await resolveProjectCommand(
          definition,
          fixture.projectPath,
          undefined,
          request.params,
        );
        return projectCommandIdentity(definition, resolved);
      }),
    );
    const configPath = join(await realpath(userAgent), "bash-tools.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 2,
        environment: { version: 1 },
        projectCommands: {
          version: 1,
          global: { allow: [], deny: [] },
          projects: { [fixture.projectPath]: { allow: identities, deny: [] } },
        },
      }),
    );
    const tool = createProjectCommandToolForTesting({ configPath });
    const responseEntries = await Promise.all(
      requests.map(async (request) => {
        const response = await tool.execute(
          request.commandId,
          request.params,
          undefined,
          undefined,
          {
            cwd: fixture.directory,
            mode: "print",
            hasUI: false,
            signal: undefined,
            ui: { select: async () => undefined },
          },
        );
        return [request.commandId, response.details] as const;
      }),
    );
    const responses = new Map(responseEntries);

    expect(responses.get("workspace_path")).toMatchObject({
      status: "success",
      stdout: { text: `${fixture.projectPath}\n` },
    });
    expect(responses.get("node_version")).toMatchObject({
      status: "success",
      stdout: { text: expect.stringMatching(/^v\d+(?:\.\d+){2}\n$/u) },
    });
    expect(responses.get("node_project_info")).toMatchObject({
      status: "success",
      projectInfo: {
        packageManager: { manager: "npm", executableAvailable: true },
        applicableCommands: [
          "node_project_info",
          "node_deps_list",
          "node_test",
          "node_build",
          "node_lint",
          "node_typecheck",
          "fallow_dead_code",
          "fallow_dupes",
          "fallow_health",
          "fallow_audit",
          "fallow_list_entry_points",
          "fallow_list_boundaries",
        ],
      },
    });
    expect(responses.get("node_deps_list")).toMatchObject({
      status: "success",
      exit: { code: 0 },
      resolvedCommand: expect.stringContaining(" ls --depth=0"),
    });
    for (const commandId of ["node_build", "node_lint", "node_typecheck"] as const) {
      expect(responses.get(commandId)).toMatchObject({
        status: "success",
        stdout: { text: expect.stringContaining(`${commandId.replace("node_", "")}:none\n`) },
      });
    }
    expect(responses.get("node_test")).toMatchObject({
      status: "success",
      stdout: { text: expect.stringContaining("test:fixture-runner.js\n") },
    });
    for (const commandId of [
      "fallow_dead_code",
      "fallow_dupes",
      "fallow_health",
      "fallow_list_entry_points",
      "fallow_list_boundaries",
    ] as const) {
      const fallowCommand = commandId.startsWith("fallow_list")
        ? "list"
        : commandId.replace("fallow_", "").replaceAll("_", "-");
      expect(responses.get(commandId)).toMatchObject({
        status: "success",
        stdout: { text: expect.stringContaining(`"command":"${fallowCommand}"`) },
      });
    }
    expect(responses.get("fallow_audit")).toMatchObject({
      status: "nonzero",
      exit: { code: 1 },
    });
  });

  it("runs the real package manager list command when node_modules is absent", async () => {
    const project = await mkdtemp(join(tmpdir(), "bash-tools-node-deps-integration-project-"));
    const userAgent = await mkdtemp(join(tmpdir(), "bash-tools-node-deps-integration-policy-"));
    directories.push(project, userAgent);
    const projectPath = await realpath(project);
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ packageManager: "npm@10.0.0", dependencies: { missing: "1.0.0" } }),
    );
    const definition = getProjectCommandDefinition("node_deps_list");
    if (definition === undefined) throw new Error("missing node_deps_list definition");
    const resolved = await resolveNodeProjectCommand(definition, projectPath, {
      commandId: "node_deps_list",
    });
    const configPath = join(await realpath(userAgent), "bash-tools.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 2,
        environment: { version: 1 },
        projectCommands: {
          version: 1,
          global: { allow: [], deny: [] },
          projects: {
            [projectPath]: {
              allow: [projectCommandIdentity(definition, resolved)],
              deny: [],
            },
          },
        },
      }),
    );
    const response = await createProjectCommandToolForTesting({ configPath }).execute(
      "node-deps",
      { commandId: "node_deps_list" },
      undefined,
      undefined,
      {
        cwd: project,
        mode: "print",
        hasUI: false,
        signal: undefined,
        ui: { select: async () => undefined },
      },
    );
    expect(response.details).toMatchObject({
      status: "nonzero",
      exit: { code: 1, signal: null },
      resolvedCommand: expect.stringContaining(" ls --depth=0"),
      stderr: { text: expect.any(String) },
    });
  });

  it("runs an authorized exact Node test script with a validated path", async () => {
    const project = await mkdtemp(join(tmpdir(), "bash-tools-node-script-integration-project-"));
    const userAgent = await mkdtemp(join(tmpdir(), "bash-tools-node-script-integration-policy-"));
    directories.push(project, userAgent);
    const projectPath = await realpath(project);
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ packageManager: "npm@10.0.0", scripts: { test: "node runner.js" } }),
    );
    await writeFile(
      join(project, "runner.js"),
      'process.stdout.write(`${process.env.CI}:${process.argv[2] || "none"}\\n`);',
    );
    const definition = getProjectCommandDefinition("node_test");
    if (definition === undefined) throw new Error("missing node_test definition");
    const resolved = await resolveNodeProjectCommand(definition, projectPath, {
      commandId: "node_test",
      paths: ["runner.js"],
    });
    const configPath = join(await realpath(userAgent), "bash-tools.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 2,
        environment: { version: 1 },
        projectCommands: {
          version: 1,
          global: { allow: [], deny: [] },
          projects: {
            [projectPath]: {
              allow: [projectCommandIdentity(definition, resolved)],
              deny: [],
            },
          },
        },
      }),
    );
    const tool = createProjectCommandToolForTesting({ configPath });
    const response = await tool.execute(
      "node-test",
      { commandId: "node_test", paths: ["runner.js"] },
      undefined,
      undefined,
      {
        cwd: project,
        mode: "print",
        hasUI: false,
        signal: undefined,
        ui: { select: async () => undefined },
      },
    );
    expect(response.details).toMatchObject({
      commandId: "node_test",
      status: "success",
      parameters: { paths: ["runner.js"] },
      resolvedCommand: expect.stringContaining(" run test -- runner.js"),
    });
    expect(response.details.stdout.text).toContain("true:runner.js");
  });

  it("runs both fixed commands from user policy and ignores repository policy files", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-tools-project-command-integration-"));
    directories.push(root);
    const canonicalRoot = await realpath(root);
    const project = join(canonicalRoot, "project");
    const userAgent = join(canonicalRoot, "user-agent");
    await mkdir(project);
    await mkdir(join(project, ".pi"));
    await writeFile(
      join(project, ".pi", "bash-tools.json"),
      JSON.stringify({ version: 2, projectCommands: { global: { deny: [] } } }),
    );
    const projectPath = await realpath(project);
    const configPath = join(userAgent, "bash-tools.json");
    const identities = getProjectCommandDefinitions().map(projectCommandIdentity);
    await mkdir(userAgent);
    await writeFile(
      configPath,
      JSON.stringify({
        version: 2,
        environment: { version: 1 },
        projectCommands: {
          version: 1,
          global: { allow: [], deny: [] },
          projects: { [projectPath]: { allow: identities, deny: [] } },
        },
      }),
    );
    const tool = createProjectCommandToolForTesting({ configPath });
    const workspace = await tool.execute(
      "workspace",
      { commandId: "workspace_path" },
      undefined,
      undefined,
      {
        cwd: project,
        mode: "print",
        hasUI: false,
        signal: undefined,
        ui: { select: async () => undefined },
      },
    );
    const node = await tool.execute("node", { commandId: "node_version" }, undefined, undefined, {
      cwd: project,
      mode: "json",
      hasUI: false,
      signal: undefined,
      ui: { select: async () => undefined },
    });
    expect(workspace.details).toMatchObject({
      commandId: "workspace_path",
      projectPath,
      status: "success",
      exit: { code: 0, signal: null },
      stdout: { text: `${projectPath}\n`, truncated: false },
    });
    expect(node.details).toMatchObject({
      commandId: "node_version",
      projectPath,
      status: "success",
      exit: { code: 0, signal: null },
    });
    expect(node.details.stdout.text.trim()).toMatch(/^v\d+(?:\.\d+){2}/u);
    expect(await readFile(configPath, "utf8")).toContain("projectCommands");
  });
});
