import { readFile, realpath } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEnvironmentToolForTesting } from "./environment-tool.ts";
import { EnvironmentToolError } from "./environment-schema.ts";
import { createEnvironmentToolTestFixtures } from "./environment-tool-test-fixtures.ts";
import type { PolicyStore } from "../policy/types.ts";

const fixtures = createEnvironmentToolTestFixtures();

afterEach(() => fixtures.cleanup());

describe("environment tool authorization", () => {
  it("reports a dismissed confirmation without classifying it as cancellation", async () => {
    const fixture = await fixtures.createPolicyFixture();
    const tool = createEnvironmentToolForTesting({
      configPath: fixture.configPath,
      environment: { DISMISSED: "secret" },
    });
    const execution = tool.execute(
      "1",
      { keys: ["DISMISSED"] },
      undefined,
      undefined,
      fixtures.context(fixture.directory, {
        mode: "tui",
        hasUI: true,
        select: async () => undefined,
      }),
    );
    await expect(execution).rejects.toBeInstanceOf(EnvironmentToolError);
    await expect(execution).rejects.toMatchObject({
      message: "Environment confirmation cancelled",
      name: "EnvironmentToolError",
    });
    expect(JSON.parse(await readFile(fixture.configPath, "utf8"))).toEqual({
      version: 1,
      global: {},
    });
  });

  it("reports request cancellation when policy loading fails after abort", async () => {
    const fixture = await fixtures.createPolicyFixture();
    const controller = new AbortController();
    const policy: PolicyStore = {
      configPath: fixture.configPath,
      load: async () => {
        controller.abort();
        throw new Error("policy load failed");
      },
      recordDecisions: async () => undefined,
    };
    const tool = createEnvironmentToolForTesting({
      configPath: fixture.configPath,
      policy,
      environment: { LOADING: "secret" },
    });
    await expect(
      tool.execute(
        "1",
        { keys: ["LOADING"] },
        controller.signal,
        undefined,
        fixtures.context(fixture.directory),
      ),
    ).rejects.toMatchObject({
      message: "Environment request cancelled",
      name: "AbortError",
    });
  });

  it("maps non-cancellation policy load failures", async () => {
    const fixture = await fixtures.createPolicyFixture();
    const policy: PolicyStore = {
      configPath: fixture.configPath,
      load: async () => {
        throw new Error("policy load failed");
      },
      recordDecisions: async () => undefined,
    };
    const tool = createEnvironmentToolForTesting({
      configPath: fixture.configPath,
      policy,
      environment: { LOADING: "secret" },
    });
    await expect(
      tool.execute(
        "1",
        { keys: ["LOADING"] },
        undefined,
        undefined,
        fixtures.context(fixture.directory),
      ),
    ).rejects.toMatchObject({
      message: "Unable to load environment policy",
      name: "EnvironmentToolError",
    });
  });

  it("rejects unknown keys without UI and does not modify policy", async () => {
    const fixture = await fixtures.createPolicyFixture();
    const tool = createEnvironmentToolForTesting({
      configPath: fixture.configPath,
      environment: { UNKNOWN: "value" },
    });
    await expect(
      tool.execute(
        "1",
        { keys: ["UNKNOWN"] },
        undefined,
        undefined,
        fixtures.context(fixture.directory),
      ),
    ).rejects.toThrow(/not authorized/iu);
    expect(JSON.parse(await readFile(fixture.configPath, "utf8"))).toEqual({
      version: 1,
      global: {},
    });
  });

  it("prompts in order and persists each choice before returning all values", async () => {
    const fixture = await fixtures.createPolicyFixture();
    const choices = ["Allow for this project", "Allow globally"];
    const select = vi.fn(async (_title: string, options: string[]) => {
      expect(options).toEqual([
        "Deny globally",
        "Deny for this project",
        "Allow globally",
        "Allow for this project",
      ]);
      return choices.shift();
    });
    const tool = createEnvironmentToolForTesting({
      configPath: fixture.configPath,
      environment: { FIRST: "one", SECOND: "two" },
    });
    const response = await tool.execute(
      "1",
      { keys: ["FIRST", "SECOND"] },
      undefined,
      undefined,
      fixtures.context(fixture.directory, { mode: "tui", hasUI: true, select }),
    );
    expect(select).toHaveBeenCalledTimes(2);
    expect(response.details.values).toEqual({ FIRST: "one", SECOND: "two" });
    const saved = JSON.parse(await readFile(fixture.configPath, "utf8"));
    const projectPath = await realpath(fixture.directory);
    expect(saved).toMatchObject({
      global: { allow: ["SECOND"] },
      projects: { [projectPath]: { allow: ["FIRST"] } },
    });
  });

  it("reports synchronous selection failures as confirmation errors", async () => {
    const fixture = await fixtures.createPolicyFixture();
    const tool = createEnvironmentToolForTesting({
      configPath: fixture.configPath,
      environment: { SYNC_FAILURE: "secret" },
    });
    await expect(
      tool.execute(
        "1",
        { keys: ["SYNC_FAILURE"] },
        undefined,
        undefined,
        fixtures.context(fixture.directory, {
          mode: "tui",
          hasUI: true,
          select: () => {
            throw new Error("selection failed");
          },
        }),
      ),
    ).rejects.toThrow(/confirmation failed/iu);
    expect(JSON.parse(await readFile(fixture.configPath, "utf8"))).toEqual({
      version: 1,
      global: {},
    });
  });

  it("aborts a multi-key call before reading values when a later key is denied", async () => {
    const fixture = await fixtures.createPolicyFixture({ allow: ["FIRST"], deny: ["SECOND"] });
    const reads: string[] = [];
    const environment = new Proxy(
      { FIRST: "one", SECOND: "two" },
      {
        get(target, property, receiver) {
          if (typeof property === "string") {
            reads.push(property);
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const tool = createEnvironmentToolForTesting({ configPath: fixture.configPath, environment });
    await expect(
      tool.execute(
        "1",
        { keys: ["FIRST", "SECOND"] },
        undefined,
        undefined,
        fixtures.context(fixture.directory),
      ),
    ).rejects.toThrow(/denied/iu);
    expect(reads).toEqual([]);
  });
  it("aborts without values when an interactive decision denies a key", async () => {
    const fixture = await fixtures.createPolicyFixture();
    const reads: string[] = [];
    const environment = new Proxy(
      { DENIED_KEY: "secret" },
      {
        get(target, property, receiver) {
          if (typeof property === "string") {
            reads.push(property);
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const tool = createEnvironmentToolForTesting({
      configPath: fixture.configPath,
      environment,
    });
    await expect(
      tool.execute(
        "1",
        { keys: ["DENIED_KEY"] },
        undefined,
        undefined,
        fixtures.context(fixture.directory, {
          mode: "tui",
          hasUI: true,
          select: async () => "Deny globally",
        }),
      ),
    ).rejects.toThrow(/denied/iu);
    expect(reads).toEqual([]);
    expect(JSON.parse(await readFile(fixture.configPath, "utf8"))).toMatchObject({
      global: { deny: ["DENIED_KEY"] },
    });
  });
});
