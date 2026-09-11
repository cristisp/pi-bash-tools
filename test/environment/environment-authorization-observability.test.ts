import { readFile, realpath } from "node:fs/promises";

import { afterEach, expect, it, vi } from "vitest";

import type { AuthorizationOutcomeRecord } from "../../src/observability/authorization-outcome.ts";
import { createAuthorizationRetryTracker } from "../../src/tools/authorization-retry.ts";
import type { EnvironmentToolContext } from "../../src/tools/environment/environment-tool.ts";
import { createEnvironmentToolForTesting } from "../../src/tools/environment/environment-tool.ts";
import { createEnvironmentToolTestFixtures } from "./environment-tool-test-fixtures.ts";

const fixtures = createEnvironmentToolTestFixtures();

afterEach(() => fixtures.cleanup());

function contextWithSession(
  cwd: string,
  overrides: Partial<Pick<EnvironmentToolContext, "mode" | "hasUI" | "signal">> & {
    select?: EnvironmentToolContext["ui"]["select"];
  } = {},
): EnvironmentToolContext {
  return {
    ...fixtures.context(cwd, overrides),
    sessionManager: { getSessionId: () => "observability-session" },
  };
}

it("records a persisted denial end to end without a prompt when policy denies", async () => {
  const fixture = await fixtures.createPolicyFixture({ deny: ["DENIED_KEY"] });
  const records: AuthorizationOutcomeRecord[] = [];
  const tool = createEnvironmentToolForTesting({
    configPath: fixture.configPath,
    environment: { DENIED_KEY: "secret" },
    authorizationOutcomeRecorder: (record) => records.push(record),
  });

  await expect(
    tool.execute(
      "call-1",
      { keys: ["DENIED_KEY"] },
      undefined,
      undefined,
      contextWithSession(fixture.directory),
    ),
  ).rejects.toThrow(/denied by policy/iu);

  expect(records).toEqual([
    {
      authorizationFormatVersion: 1,
      surface: "environment",
      commandId: "environment",
      sessionId: "observability-session",
      toolCallId: "call-1",
      outcome: "denied",
      decisionPersisted: false,
      promptEmitted: false,
      promptWaitMs: 0,
      executionAttempted: false,
    },
  ]);
  const saved = JSON.parse(await readFile(fixture.configPath, "utf8"));
  expect(saved.global.deny).toEqual(["DENIED_KEY"]);
});

it("records deferred persistence and the later commit for prompt approvals", async () => {
  const fixture = await fixtures.createPolicyFixture();
  const records: AuthorizationOutcomeRecord[] = [];
  const tool = createEnvironmentToolForTesting({
    configPath: fixture.configPath,
    environment: { ALLOWED_KEY: "secret" },
    authorizationOutcomeRecorder: (record) => records.push(record),
  });

  const outcome = await tool.execute(
    "call-2",
    { keys: ["ALLOWED_KEY"] },
    undefined,
    undefined,
    contextWithSession(fixture.directory, {
      mode: "tui",
      hasUI: true,
      select: async () => "Allow for this project",
    }),
  );

  expect(outcome.details.values).toEqual({ ALLOWED_KEY: "secret" });
  expect(records.map((record) => record.outcome)).toEqual([
    "deferred-persistence",
    "deferred-decision-persisted",
  ]);
  expect(records.every((record) => record.surface === "environment")).toBe(true);
  expect(records.every((record) => record.sessionId === "observability-session")).toBe(true);
  const saved = JSON.parse(await readFile(fixture.configPath, "utf8"));
  expect(saved.projects[await realpath(fixture.directory)].allow).toEqual(["ALLOWED_KEY"]);
});

it("rejects an unchanged retry after a persisted denial without re-prompting", async () => {
  const fixture = await fixtures.createPolicyFixture();
  const records: AuthorizationOutcomeRecord[] = [];
  const select = vi.fn(async () => "Deny for this project");
  const context = () => contextWithSession(fixture.directory, { mode: "tui", hasUI: true, select });
  const tool = createEnvironmentToolForTesting({
    configPath: fixture.configPath,
    environment: { RETRY_KEY: "secret" },
    authorizationOutcomeRecorder: (record) => records.push(record),
    authorizationRetryTracker: createAuthorizationRetryTracker(),
  });

  await expect(
    tool.execute("retry-1", { keys: ["RETRY_KEY"] }, undefined, undefined, context()),
  ).rejects.toThrow(/denied by policy/iu);
  expect(select).toHaveBeenCalledOnce();
  expect(records.map((record) => record.outcome)).toEqual(["denied"]);

  await expect(
    tool.execute("retry-2", { keys: ["RETRY_KEY"] }, undefined, undefined, context()),
  ).rejects.toThrow(/already denied|unchanged/iu);
  expect(select).toHaveBeenCalledOnce();
  expect(records.map((record) => record.outcome)).toEqual([
    "denied",
    "unchanged-retry-after-denial",
  ]);
  expect(records[1]).toMatchObject({
    surface: "environment",
    sessionId: "observability-session",
    decisionPersisted: false,
    promptEmitted: false,
    executionAttempted: false,
  });
  const saved = JSON.parse(await readFile(fixture.configPath, "utf8"));
  expect(saved.projects[await realpath(fixture.directory)].deny).toEqual(["RETRY_KEY"]);
});
