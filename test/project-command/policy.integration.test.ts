import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectCommandToolForTesting } from "../../src/tools/project-command/tool.ts";
import {
  getProjectCommandDefinitions,
  projectCommandIdentity,
} from "../../src/tools/project-command/definitions.ts";
import {
  createIntegrationDirectory,
  createProjectCommandIntegrationScope,
  executeCommand,
  writeProjectPolicy,
} from "./integration-fixtures.ts";

const scope = createProjectCommandIntegrationScope();

afterEach(scope.cleanup);

describe("project command policy integration", () => {
  it("runs both fixed commands from user policy and ignores repository policy files", async () => {
    const root = await createIntegrationDirectory(scope, "bash-tools-project-command-integration-");
    const project = join(root, "project");
    const userAgent = join(root, "user-agent");
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
    await writeProjectPolicy(configPath, projectPath, identities);
    const tool = createProjectCommandToolForTesting({ configPath });

    const workspace = await executeCommand(
      tool,
      "workspace",
      { commandId: "workspace_path" },
      project,
    );
    const node = await executeCommand(tool, "node", { commandId: "node_version" }, project, "json");
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
