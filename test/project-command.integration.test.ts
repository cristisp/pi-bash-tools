import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectCommandToolForTesting } from "../src/tools/project-command/tool.ts";
import {
  getProjectCommandDefinitions,
  projectCommandIdentity,
} from "../src/tools/project-command/definitions.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("project command integration", () => {
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
