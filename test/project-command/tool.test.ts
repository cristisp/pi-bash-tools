import { readFile, realpath, writeFile } from "node:fs/promises";

import { afterEach, expect, it } from "vitest";

import {
  getProjectCommandDefinition,
  projectCommandIdentity,
} from "../../src/tools/project-command/definitions.ts";
import { ProjectCommandResolutionError } from "../../src/tools/project-command/errors.ts";
import { resolveFixedProjectCommand } from "../../src/tools/project-command/resolution.ts";
import type { ResolvedProjectCommand } from "../../src/tools/project-command/resolution/types.ts";
import { createProjectCommandToolForTesting } from "../../src/tools/project-command/tool.ts";
import {
  cleanupProjectCommandFixtures,
  context,
  fixture,
  successExecutor,
} from "./tool-test-fixtures.ts";

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
      category: "RESOLUTION_FAILURE",
      executed: false,
      commandId: "workspace_path",
      toolCallId: "1",
      reused: false,
      durationMs: expect.any(Number),
      executionDurationMs: 0,
      suggestedAction: "Review the project metadata and dependencies, then retry the command.",
      error: {
        code: "missing-binary",
        category: "RESOLUTION_FAILURE",
        suggestedAction: "Review the project metadata and dependencies, then retry the command.",
        retryable: true,
        executed: false,
      },
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
  ).rejects.toMatchObject({
    message: expect.stringMatching(/not authorized/iu),
    contract: {
      code: "policy-not-authorized",
      category: "BLOCKED",
      retryable: false,
      executed: false,
    },
    details: {
      category: "BLOCKED",
      executed: false,
      toolCallId: "1",
      reused: false,
      durationMs: expect.any(Number),
      executionDurationMs: 0,
      suggestedAction:
        "Request authorization or adjust the project command policy before retrying.",
      error: {
        category: "BLOCKED",
        suggestedAction:
          "Request authorization or adjust the project command policy before retrying.",
      },
    },
  });
  expect(JSON.parse(await readFile(fixtureData.configPath, "utf8"))).toEqual({ version: 1 });
});
