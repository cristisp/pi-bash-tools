import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectCommandToolForTesting } from "../../src/tools/project-command/tool.ts";
import {
  createCommandContext,
  createIntegrationDirectory,
  createProjectCommandIntegrationScope,
} from "./integration-fixtures.ts";

const scope = createProjectCommandIntegrationScope();

afterEach(scope.cleanup);

describe("project command missing-script integration", () => {
  it("reports missing fixed Node scripts through the tool resolution error details", async () => {
    const project = await createIntegrationDirectory(
      scope,
      "bash-tools-node-missing-script-integration-project-",
    );
    const userAgent = await createIntegrationDirectory(
      scope,
      "bash-tools-node-missing-script-integration-policy-",
    );
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({
        packageManager: "npm@10.0.0",
        scripts: {
          build: "node build.js",
          "format:checker": "node check-format.js",
          zed: "node zed.js",
        },
      }),
    );
    const configPath = join(userAgent, "bash-tools.json");
    await writeFile(configPath, JSON.stringify({ version: 1 }));
    const tool = createProjectCommandToolForTesting({ configPath });
    const cases = [
      { commandId: "node_format_check", script: "format:check" },
      { commandId: "node_format_write", script: "format" },
      { commandId: "node_lint_fix", script: "lint:fix" },
      { commandId: "node_test", script: "test" },
    ] as const;

    await Promise.all(
      cases.map(async ({ commandId, script }) => {
        await expect(
          tool.execute(
            commandId,
            { commandId },
            undefined,
            undefined,
            createCommandContext(project),
          ),
        ).rejects.toMatchObject({
          name: "ProjectCommandToolError",
          message: expect.stringMatching(
            new RegExp(
              `commandId: ${commandId}.*stage: probe.*code: inapplicable-command.*not attempted`,
              "u",
            ),
          ),
          details: {
            status: "resolution-failure",
            executed: false,
            commandId,
            requestedParameters: { commandId },
            stage: "probe",
            code: "inapplicable-command",
            resolutionDetails: {
              commandId,
              requiredPackageScript: script,
              packageManagerCommand: `npm run ${script}`,
              availableScripts: ["build", "format:checker", "zed"],
              applicableCommands: expect.arrayContaining(["node_project_info"]),
            },
          },
        });
      }),
    );
  });
});
