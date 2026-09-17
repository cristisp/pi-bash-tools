import { afterEach, expect, it } from "vitest";

import { getProjectCommandDefinition } from "../../src/tools/project-command/definitions.ts";
import {
  createProjectCommandErrorDetailsStore,
  createProjectCommandToolResultHandler,
} from "../../src/tools/project-command/error-details.ts";
import { ProjectCommandResolutionError } from "../../src/tools/project-command/errors.ts";
import type { ProjectCommandExecutionOutcome } from "../../src/tools/project-command/execution.ts";
import { resolveFixedProjectCommand } from "../../src/tools/project-command/resolution.ts";
import { createProjectCommandToolForTesting } from "../../src/tools/project-command/tool.ts";
import { authorize } from "./tool-execution-helpers.ts";
import { cleanupProjectCommandFixtures, context, fixture } from "./tool-test-fixtures.ts";

afterEach(cleanupProjectCommandFixtures);

function resultEvent(
  toolCallId: string,
  input: Record<string, unknown>,
): Parameters<ReturnType<typeof createProjectCommandToolResultHandler>>[0] {
  return {
    type: "tool_result",
    toolName: "project_command",
    toolCallId,
    input,
    content: [{ type: "text", text: "project command failed" }],
    details: undefined,
    isError: true,
  };
}

it("preserves resolution-specific codes through the host result boundary", async () => {
  const fixtureData = await fixture();
  const store = createProjectCommandErrorDetailsStore();
  const handler = createProjectCommandToolResultHandler(store);
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    errorDetailsRecorder: store.record,
    resolver: async () => {
      throw new ProjectCommandResolutionError("probe", "test-path-outside-workspace");
    },
  });

  await expect(
    tool.execute(
      "resolution-host",
      { commandId: "node_test", paths: ["escape.ts"] },
      undefined,
      undefined,
      context(fixtureData.directory),
    ),
  ).rejects.toBeDefined();

  const details = handler(
    resultEvent("resolution-host", { commandId: "node_test", paths: ["escape.ts"] }),
  )?.details;
  expect(details).toMatchObject({
    resultCategory: "RESOLUTION_FAILURE",
    executed: false,
    retryable: true,
    error: { code: "test-path-outside-workspace" },
    code: "test-path-outside-workspace",
  });
  expect(details).not.toHaveProperty("ref");
});

it("preserves policy denials through the host result boundary without evidence", async () => {
  const fixtureData = await fixture();
  const store = createProjectCommandErrorDetailsStore();
  const handler = createProjectCommandToolResultHandler(store);
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    errorDetailsRecorder: store.record,
  });

  await expect(
    tool.execute(
      "policy-host",
      { commandId: "workspace_path" },
      undefined,
      undefined,
      context(fixtureData.directory),
    ),
  ).rejects.toBeDefined();

  const details = handler(resultEvent("policy-host", { commandId: "workspace_path" }))?.details;
  expect(details).toMatchObject({
    resultCategory: "BLOCKED",
    executed: false,
    retryable: false,
    error: { code: "policy-not-authorized" },
  });
  expect(details).not.toHaveProperty("ref");
});

it("preserves executed format failures through the host result boundary", async () => {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("node_format");
  if (definition === undefined) throw new Error("missing node_format definition");
  const resolved = resolveFixedProjectCommand(definition);
  await authorize(fixtureData, definition, resolved);
  const outcome: ProjectCommandExecutionOutcome = {
    status: "nonzero",
    exit: { code: 1, signal: null },
    timedOut: false,
    cancelled: false,
    stdout: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
    stderr: { text: "format failed", truncated: false, totalBytes: 12, totalLines: 1 },
  };
  const store = createProjectCommandErrorDetailsStore();
  const handler = createProjectCommandToolResultHandler(store);
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    errorDetailsRecorder: store.record,
    executor: async () => outcome,
    resolver: async () => resolved,
  });

  await expect(
    tool.execute(
      "format-host",
      { commandId: "node_format" },
      undefined,
      undefined,
      context(fixtureData.directory),
    ),
  ).rejects.toBeDefined();

  const details = handler(resultEvent("format-host", { commandId: "node_format" }))?.details;
  expect(details).toMatchObject({
    resultCategory: "FORMAT_FAILURE",
    executed: true,
    retryable: true,
    diagnostic: "format failed",
    error: { category: "FORMAT_FAILURE", executed: true },
  });
});

it("classifies host schema rejection without invoking a command", () => {
  const handler = createProjectCommandToolResultHandler(createProjectCommandErrorDetailsStore());
  const details = handler(
    resultEvent("schema-host", { commandId: "node_lint", variant: "-unsafe" }),
  )?.details;
  expect(details).toMatchObject({
    resultCategory: "INVALID_REQUEST",
    executed: false,
    retryable: false,
    error: { code: "invalid-request", invalidField: "variant" },
  });
});
