import { afterEach, describe, expect, it } from "vitest";

import { getProjectCommandDefinition } from "../../../src/tools/project-command/definitions.ts";
import {
  readNodeProjectInfo,
  resolveNodeProjectCommand,
} from "../../../src/tools/project-command/node.ts";
import { createNodeProject, createNodeTestScope } from "./test-fixtures.ts";

const scope = createNodeTestScope();

afterEach(scope.cleanup);

describe("Node missing script diagnostics", () => {
  it("reports the required script and fixed manager command for every missing Node script", async () => {
    const directory = await createNodeProject(scope, {
      packageManager: "npm@10.0.0",
      scripts: {
        zed: "node zed.js",
        build: "node build.js",
        "format:checker": "node check-format.js",
      },
    });
    const info = await readNodeProjectInfo(directory);
    const cases = [
      { commandId: "node_format", parameters: { commandId: "node_format" }, script: "format" },
      {
        commandId: "node_format",
        parameters: { commandId: "node_format", variant: "check" },
        script: "format:check",
      },
      {
        commandId: "node_lint",
        parameters: { commandId: "node_lint", variant: "fix" },
        script: "lint:fix",
      },
      { commandId: "node_test", parameters: { commandId: "node_test" }, script: "test" },
      {
        commandId: "node_test",
        parameters: { commandId: "node_test", variant: "coverage" },
        script: "test:coverage",
      },
      {
        commandId: "node_test",
        parameters: { commandId: "node_test", variant: "e2e" },
        script: "test:e2e",
      },
    ] as const;

    await Promise.all(
      cases.map(async ({ commandId, parameters, script }) => {
        const definition = getProjectCommandDefinition(commandId);
        if (definition === undefined) throw new Error(`missing ${commandId} definition`);
        await expect(
          resolveNodeProjectCommand(definition, directory, parameters),
        ).rejects.toMatchObject({
          name: "ProjectCommandResolutionError",
          stage: "probe",
          code: "inapplicable-command",
          details: {
            commandId,
            requiredPackageScript: script,
            packageManagerCommand: `npm run ${script}`,
            availableScripts: ["build", "format:checker", "zed"],
            applicableCommands: info.applicableCommands,
          },
        });
      }),
    );
  });
});
