import { realpath, writeFile } from "node:fs/promises";

import { expect } from "vitest";

import {
  getProjectCommandDefinition,
  projectCommandIdentity,
  type ProjectCommandDefinition,
} from "../../src/tools/project-command/definitions.ts";
import type { ProjectCommandExecutionOutcome } from "../../src/tools/project-command/execution.ts";
import { resolveFixedProjectCommand } from "../../src/tools/project-command/resolution.ts";
import type { ResolvedProjectCommand } from "../../src/tools/project-command/resolution/types.ts";
import { ProjectCommandToolError } from "../../src/tools/project-command/schema.ts";
import { createProjectCommandToolForTesting } from "../../src/tools/project-command/tool.ts";
import { context, fixture } from "./tool-test-fixtures.ts";

export async function authorize(
  fixtureData: { readonly directory: string; readonly configPath: string },
  definition: NonNullable<ProjectCommandDefinition>,
  resolved: ResolvedProjectCommand,
): Promise<string> {
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
          [projectPath]: { allow: [projectCommandIdentity(definition, resolved)], deny: [] },
        },
      },
    }),
  );
  return projectPath;
}

export async function executeInjectedOutcome(
  outcome: ProjectCommandExecutionOutcome,
  abortBeforeResolve: boolean,
): Promise<ProjectCommandToolError> {
  const fixtureData = await fixture();
  const definition = getProjectCommandDefinition("workspace_path");
  if (definition === undefined) throw new Error("missing workspace_path definition");
  const resolved = resolveFixedProjectCommand(definition);
  await authorize(fixtureData, definition, resolved);
  const controller = new AbortController();
  const tool = createProjectCommandToolForTesting({
    configPath: fixtureData.configPath,
    executor: async (_resolved, _cwd, signal) => {
      if (abortBeforeResolve) {
        if (signal !== controller.signal) throw new Error("missing request signal");
        controller.abort();
      }
      return outcome;
    },
  });
  const error = await tool
    .execute(
      "returned-outcome-cancellation",
      { commandId: "workspace_path" },
      abortBeforeResolve ? controller.signal : undefined,
      undefined,
      context(fixtureData.directory),
    )
    .catch((rejection: unknown) => rejection);
  if (!(error instanceof ProjectCommandToolError)) {
    throw new Error("expected a ProjectCommandToolError");
  }
  return error;
}

export function expectInvocationMetadata(details: unknown, toolCallId: string): void {
  expect(details).toMatchObject({
    toolCallId,
    reused: false,
    durationMs: expect.any(Number),
    executionDurationMs: expect.any(Number),
  });
  if (typeof details !== "object" || details === null) {
    throw new Error("expected invocation metadata details");
  }
  if (
    !("durationMs" in details) ||
    !("executionDurationMs" in details) ||
    typeof details.durationMs !== "number" ||
    typeof details.executionDurationMs !== "number"
  ) {
    throw new Error("invalid invocation metadata values");
  }
  expect(Number.isFinite(details.durationMs)).toBe(true);
  expect(Number.isFinite(details.executionDurationMs)).toBe(true);
  expect(details.durationMs).toBeGreaterThanOrEqual(0);
  expect(details.executionDurationMs).toBeGreaterThanOrEqual(0);
  expect(details.durationMs).toBeGreaterThanOrEqual(details.executionDurationMs);
}
