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

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("project command integration", () => {
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
