import { readFile, realpath, rename, writeFile as writeFileToDisk } from "node:fs/promises";

import { afterEach, expect, it } from "vitest";

import { createEnvironmentToolForTesting } from "../../src/tools/environment/environment-tool.ts";
import type { PolicyFileSystem } from "../../src/tools/policy/types.ts";
import { createEnvironmentToolTestFixtures } from "./environment-tool-test-fixtures.ts";

const fixtures = createEnvironmentToolTestFixtures();

afterEach(() => fixtures.cleanup());

function createDelayedPolicyWrite(): {
  readonly fs: Pick<PolicyFileSystem, "writeFile">;
  readonly writeStarted: Promise<void>;
  readonly continueWrite: () => void;
} {
  let signalWriteStarted!: () => void;
  let continueWrite!: () => void;
  const writeStarted = new Promise<void>((resolve) => {
    signalWriteStarted = resolve;
  });
  const writeMayContinue = new Promise<void>((resolve) => {
    continueWrite = resolve;
  });
  const fs: Pick<PolicyFileSystem, "writeFile"> = {
    writeFile: async (path, data, options) => {
      if (path.endsWith(".tmp")) {
        signalWriteStarted();
        await writeMayContinue;
      }
      await writeFileToDisk(path, data, options);
    },
  };
  return { fs, writeStarted, continueWrite };
}

it("cancels before the atomic policy commit when persistence is delayed", async () => {
  const fixture = await fixtures.createPolicyFixture();
  const controller = new AbortController();
  const delayedWrite = createDelayedPolicyWrite();
  const reads: string[] = [];
  const tool = createEnvironmentToolForTesting({
    configPath: fixture.configPath,
    environment: new Proxy(
      { DELAYED: "secret" },
      {
        get(target, property, receiver) {
          if (typeof property === "string") {
            reads.push(property);
          }
          return Reflect.get(target, property, receiver);
        },
      },
    ),
    fs: delayedWrite.fs,
  });
  const execution = tool.execute(
    "1",
    { keys: ["DELAYED"] },
    undefined,
    undefined,
    fixtures.context(fixture.directory, {
      mode: "tui",
      hasUI: true,
      signal: controller.signal,
      select: async () => "Allow for this project",
    }),
  );
  await delayedWrite.writeStarted;
  controller.abort();
  delayedWrite.continueWrite();
  await expect(execution).rejects.toThrow(/cancelled/iu);
  await expect(execution).rejects.toMatchObject({
    contract: {
      code: "cancelled",
      category: "CANCELLED",
      retryable: true,
      executed: false,
    },
  });
  expect(reads).toEqual([]);
  expect(JSON.parse(await readFile(fixture.configPath, "utf8"))).toEqual({
    version: 1,
    global: {},
  });
});

it.each(["deny", "timeout"] as const)(
  "does not commit a %s decision when cancellation arrives before rename",
  async (decisionKind) => {
    const fixture = await fixtures.createPolicyFixture();
    if (decisionKind === "timeout") {
      await writeFileToDisk(
        fixture.configPath,
        JSON.stringify({ version: 1, confirmationTimeoutMs: 1 }),
      );
    }
    const controller = new AbortController();
    const delayedWrite = createDelayedPolicyWrite();
    const tool = createEnvironmentToolForTesting({
      configPath: fixture.configPath,
      environment: { CANCELLED: "secret" },
      fs: delayedWrite.fs,
    });
    const execution = tool.execute(
      "1",
      { keys: ["CANCELLED"] },
      undefined,
      undefined,
      fixtures.context(fixture.directory, {
        mode: decisionKind === "timeout" ? "rpc" : "tui",
        hasUI: true,
        signal: controller.signal,
        select:
          decisionKind === "timeout"
            ? async () => new Promise<string | undefined>(() => undefined)
            : async () => "Deny globally",
      }),
    );
    await delayedWrite.writeStarted;
    controller.abort();
    delayedWrite.continueWrite();
    await expect(execution).rejects.toThrow(/cancelled/iu);
    const saved = JSON.parse(await readFile(fixture.configPath, "utf8"));
    expect(saved.global ?? {}).toEqual({});
    expect(saved.projects ?? {}).toEqual({});
  },
);

it("rejects without values when cancellation arrives after the policy commit", async () => {
  const fixture = await fixtures.createPolicyFixture();
  const controller = new AbortController();
  const tool = createEnvironmentToolForTesting({
    configPath: fixture.configPath,
    environment: { COMMITTED: "secret" },
    fs: {
      rename: async (source, destination) => {
        await rename(source, destination);
        controller.abort();
      },
    },
  });
  const execution = tool.execute(
    "1",
    { keys: ["COMMITTED"] },
    undefined,
    undefined,
    fixtures.context(fixture.directory, {
      mode: "tui",
      hasUI: true,
      signal: controller.signal,
      select: async () => "Allow for this project",
    }),
  );
  await expect(execution).rejects.toThrow(/cancelled/iu);
  const saved = JSON.parse(await readFile(fixture.configPath, "utf8"));
  const projectPath = await realpath(fixture.directory);
  expect(saved).toMatchObject({
    projects: { [projectPath]: { allow: ["COMMITTED"] } },
  });
});

it("does not persist staged decisions when a later prompt is cancelled", async () => {
  const fixture = await fixtures.createPolicyFixture();
  const choices: Array<string | undefined> = ["Allow for this project", undefined];
  const tool = createEnvironmentToolForTesting({
    configPath: fixture.configPath,
    environment: { FIRST: "one", SECOND: "two" },
  });
  await expect(
    tool.execute(
      "1",
      { keys: ["FIRST", "SECOND"] },
      undefined,
      undefined,
      fixtures.context(fixture.directory, {
        mode: "tui",
        hasUI: true,
        select: async () => choices.shift(),
      }),
    ),
  ).rejects.toThrow(/cancelled/iu);
  expect(JSON.parse(await readFile(fixture.configPath, "utf8"))).toEqual({
    version: 1,
    global: {},
  });
});

it("discards staged allows when a later prompt times out", async () => {
  const fixture = await fixtures.createPolicyFixture();
  await writeFileToDisk(
    fixture.configPath,
    JSON.stringify({ version: 1, confirmationTimeoutMs: 1 }),
  );
  const choices: Array<string | undefined> = ["Allow for this project"];
  const tool = createEnvironmentToolForTesting({
    configPath: fixture.configPath,
    environment: { FIRST: "one", SECOND: "two" },
  });
  await expect(
    tool.execute(
      "1",
      { keys: ["FIRST", "SECOND"] },
      undefined,
      undefined,
      fixtures.context(fixture.directory, {
        mode: "rpc",
        hasUI: true,
        select: async () =>
          choices.length > 0 ? choices.shift() : new Promise<string | undefined>(() => undefined),
      }),
    ),
  ).rejects.toThrow(/timed out/iu);
  const saved = JSON.parse(await readFile(fixture.configPath, "utf8"));
  const projectPath = await realpath(fixture.directory);
  expect(saved).toMatchObject({
    projects: { [projectPath]: { deny: ["SECOND"] } },
  });
  expect(saved.projects[projectPath].allow).toEqual([]);
});

it("times out to a project deny and distinguishes manual cancellation", async () => {
  const fixture = await fixtures.createPolicyFixture();
  await writeFileToDisk(
    fixture.configPath,
    JSON.stringify({ version: 1, confirmationTimeoutMs: 1 }),
  );
  const neverSelect = async () => new Promise<string | undefined>(() => undefined);
  const tool = createEnvironmentToolForTesting({
    configPath: fixture.configPath,
    environment: { TIMEOUT_KEY: "secret" },
  });
  await expect(
    tool.execute(
      "1",
      { keys: ["TIMEOUT_KEY"] },
      undefined,
      undefined,
      fixtures.context(fixture.directory, { mode: "rpc", hasUI: true, select: neverSelect }),
    ),
  ).rejects.toThrow(/timed out/iu);
  const saved = JSON.parse(await readFile(fixture.configPath, "utf8"));
  const projectPath = await realpath(fixture.directory);
  expect(saved).toMatchObject({ projects: { [projectPath]: { deny: ["TIMEOUT_KEY"] } } });

  const cancelledFixture = await fixtures.createPolicyFixture();
  const controller = new AbortController();
  const cancelTool = createEnvironmentToolForTesting({
    configPath: cancelledFixture.configPath,
    environment: { CANCEL_KEY: "secret" },
  });
  const execution = cancelTool.execute(
    "2",
    { keys: ["CANCEL_KEY"] },
    undefined,
    undefined,
    fixtures.context(cancelledFixture.directory, {
      mode: "tui",
      hasUI: true,
      signal: controller.signal,
      select: neverSelect,
    }),
  );
  controller.abort();
  await expect(execution).rejects.toMatchObject({
    message: "Environment request cancelled",
    name: "AbortError",
    contract: {
      code: "cancelled",
      category: "CANCELLED",
      retryable: true,
      executed: false,
    },
  });
  expect(JSON.parse(await readFile(cancelledFixture.configPath, "utf8"))).toEqual({
    version: 1,
    global: {},
  });
});
