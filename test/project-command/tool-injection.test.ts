import { realpath, writeFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import {
  getProjectCommandDefinitions,
  projectCommandIdentity,
  type ProjectCommandDefinition,
} from "../../src/tools/project-command/definitions.ts";
import {
  cleanupProjectCommandFixtures,
  context,
  fixture,
  successExecutor,
} from "./tool-test-fixtures.ts";
import { createProjectCommandToolForTesting } from "../../src/tools/project-command/tool.ts";

afterEach(cleanupProjectCommandFixtures);

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
