import { readFile } from "node:fs/promises";
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
  createIntegrationFixture,
  createProjectCommandIntegrationScope,
  executeCommand,
  writeProjectPolicy,
} from "./integration-fixtures.ts";

const scope = createProjectCommandIntegrationScope();

afterEach(scope.cleanup);

describe("project command authorization integration", () => {
  it("requires project authorization before executing the mutating lint fix script", async () => {
    const { fixture, userAgent } = await createIntegrationFixture(
      scope,
      "bash-tools-node-lint-fix-policy-",
    );
    const configPath = join(userAgent, "bash-tools.json");
    await writeProjectPolicy(configPath, fixture.projectPath, []);
    const tool = createProjectCommandToolForTesting({ configPath });
    const context = createCommandContext(fixture.directory);

    await expect(
      tool.execute("node-lint-fix", { commandId: "node_lint_fix" }, undefined, undefined, context),
    ).rejects.toMatchObject({
      name: "ProjectCommandToolError",
      message: "Project command is not authorized in this mode",
    });
    expect(await readFile(join(fixture.directory, "lint-fix-target.txt"), "utf8")).toBe("before\n");

    const definition = getProjectCommandDefinition("node_lint_fix");
    if (definition === undefined) throw new Error("missing node_lint_fix definition");
    const resolved = await resolveNodeProjectCommand(definition, fixture.projectPath, {
      commandId: "node_lint_fix",
    });
    await writeProjectPolicy(configPath, fixture.projectPath, [
      projectCommandIdentity(definition, resolved),
    ]);

    const response = await executeCommand(
      tool,
      "node-lint-fix",
      { commandId: "node_lint_fix" },
      fixture.directory,
    );
    expect(response.details).toMatchObject({
      commandId: "node_lint_fix",
      status: "success",
      resolvedCommand: expect.stringContaining(" run lint:fix"),
    });
    expect(await readFile(join(fixture.directory, "lint-fix-target.txt"), "utf8")).toBe("after\n");
  });
});
