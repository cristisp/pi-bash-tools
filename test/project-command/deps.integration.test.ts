import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectCommandToolForTesting } from "../../src/tools/project-command/tool.ts";
import {
  getProjectCommandDefinition,
  projectCommandIdentity,
} from "../../src/tools/project-command/definitions.ts";
import { resolveNodeProjectCommand } from "../../src/tools/project-command/node.ts";
import {
  createCommandContext,
  createIntegrationDirectory,
  createProjectCommandIntegrationScope,
  writeProjectPolicy,
} from "./integration-fixtures.ts";

const scope = createProjectCommandIntegrationScope();

afterEach(scope.cleanup);

describe("project command dependency integration", () => {
  it("runs the real package manager list command when node_modules is absent", async () => {
    const project = await createIntegrationDirectory(
      scope,
      "bash-tools-node-deps-integration-project-",
    );
    const userAgent = await createIntegrationDirectory(
      scope,
      "bash-tools-node-deps-integration-policy-",
    );
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ packageManager: "npm@10.0.0", dependencies: { missing: "1.0.0" } }),
    );
    const projectPath = project;
    const definition = getProjectCommandDefinition("node_deps_list");
    if (definition === undefined) throw new Error("missing node_deps_list definition");
    const resolved = await resolveNodeProjectCommand(definition, projectPath, {
      commandId: "node_deps_list",
    });
    const configPath = join(userAgent, "bash-tools.json");
    await writeProjectPolicy(configPath, projectPath, [
      projectCommandIdentity(definition, resolved),
    ]);

    const response = await createProjectCommandToolForTesting({ configPath }).execute(
      "node-deps",
      { commandId: "node_deps_list" },
      undefined,
      undefined,
      createCommandContext(project),
    );
    expect(response.details).toMatchObject({
      status: "nonzero",
      exit: { code: 1, signal: null },
      resolvedCommand: expect.stringContaining(" ls --depth=0"),
      stderr: { text: expect.any(String) },
    });
  });
});
