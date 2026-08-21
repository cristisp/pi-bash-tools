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
  createIntegrationDirectory,
  createProjectCommandIntegrationScope,
  executeCommand,
  writeProjectPolicy,
} from "./integration-fixtures.ts";

const scope = createProjectCommandIntegrationScope();

afterEach(scope.cleanup);

describe("project command script integration", () => {
  it("runs an authorized exact Node test script with a validated path", async () => {
    const project = await createIntegrationDirectory(
      scope,
      "bash-tools-node-script-integration-project-",
    );
    const userAgent = await createIntegrationDirectory(
      scope,
      "bash-tools-node-script-integration-policy-",
    );
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
    const resolved = await resolveNodeProjectCommand(definition, project, {
      commandId: "node_test",
      paths: ["runner.js"],
    });
    const configPath = join(userAgent, "bash-tools.json");
    await writeProjectPolicy(configPath, project, [projectCommandIdentity(definition, resolved)]);
    const tool = createProjectCommandToolForTesting({ configPath });
    const response = await executeCommand(
      tool,
      "node-test",
      { commandId: "node_test", paths: ["runner.js"] },
      project,
    );

    expect(response.details).toMatchObject({
      commandId: "node_test",
      status: "success",
      parameters: { paths: ["runner.js"] },
      resolvedCommand: expect.stringContaining(" run test -- runner.js"),
    });
    const serializedEntry = response.content[0];
    if (serializedEntry?.type !== "text") {
      throw new Error("project command response did not contain serialized text");
    }
    const serialized = JSON.parse(serializedEntry.text);
    expect(serialized).toMatchObject({
      commandId: "node_test",
      status: "success",
      parameters: { paths: ["runner.js"] },
      resolvedCommand: response.details.resolvedCommand,
    });
    expect(response.details.stdout.text).toContain("true:runner.js");
  });
});
