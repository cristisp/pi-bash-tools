import { readFile, realpath, writeFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import {
  cleanupProjectCommandFixtures,
  context,
  fixture,
  successExecutor,
} from "./tool-test-fixtures.ts";
import { createProjectCommandToolForTesting } from "../../src/tools/project-command/tool.ts";
import {
  getProjectCommandDefinition,
  projectCommandIdentity,
} from "../../src/tools/project-command/definitions.ts";
import { ProjectCommandResolutionError } from "../../src/tools/project-command/errors.ts";
import { resolveFixedProjectCommand } from "../../src/tools/project-command/resolution.ts";
import type { ResolvedProjectCommand } from "../../src/tools/project-command/resolution/types.ts";

afterEach(cleanupProjectCommandFixtures);

it("keeps resolution failures outside authorization and execution failure mapping", async () => {
  const fixtureData = await fixture();
  const executor = successExecutor();
  const resolutionError = new ProjectCommandResolutionError("binary-resolution", "missing-binary");
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    executor,
    resolver: async () => {
      throw resolutionError;
    },
  });

  await expect(
    tool.execute(
      "1",
      { commandId: "workspace_path" },
      undefined,
      undefined,
      context(fixtureData.directory),
    ),
  ).rejects.toMatchObject({
    name: "ProjectCommandToolError",
    message: expect.stringMatching(
      /commandId: workspace_path.*stage: binary-resolution.*code: missing-binary.*not attempted/u,
    ),
    details: {
      status: "resolution-failure",
      executed: false,
      commandId: "workspace_path",
      requestedParameters: { commandId: "workspace_path" },
      stage: "binary-resolution",
      code: "missing-binary",
      resolutionDetails: resolutionError.details,
    },
  });
  expect(executor).not.toHaveBeenCalled();
});

it("passes the resolved command shape through authorization and execution", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("workspace_path");
  if (definition === undefined) {
    throw new Error("missing workspace_path definition");
  }
  const resolved = {
    ...resolveFixedProjectCommand(definition),
    executable: "/bin/echo",
    args: ["resolved"],
  } satisfies ResolvedProjectCommand;
  const projectPath = await realpath(fixtureData.directory);
  const identity = projectCommandIdentity(definition, resolved);
  await writeFile(
    fixtureData.configPath,
    JSON.stringify({
      version: 2,
      environment: { version: 1 },
      projectCommands: {
        version: 1,
        global: { allow: [], deny: [] },
        projects: { [projectPath]: { allow: [identity], deny: [] } },
      },
    }),
  );
  const executor = successExecutor();
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    executor,
    resolver: async () => resolved,
  });

  await tool.execute(
    "1",
    { commandId: "workspace_path" },
    undefined,
    undefined,
    context(fixtureData.directory),
  );
  expect(executor).toHaveBeenCalledWith(resolved, projectPath, undefined);
});

it("leaves policy unchanged when an unauthorized command is rejected", async () => {
  const fixtureData = await fixture();
  const tool = createProjectCommandToolForTesting({ configPath: fixtureData.configPath });
  await expect(
    tool.execute(
      "1",
      { commandId: "workspace_path" },
      undefined,
      undefined,
      context(fixtureData.directory),
    ),
  ).rejects.toThrow(/not authorized/iu);
  expect(JSON.parse(await readFile(fixtureData.configPath, "utf8"))).toEqual({ version: 1 });
});
