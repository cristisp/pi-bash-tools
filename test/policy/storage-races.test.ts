import { mkdir, readFile, realpath, rename, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { findEnvironmentPolicyDecision } from "../../src/tools/policy/decisions.ts";
import { createPolicyStoreForTesting } from "../../src/tools/policy/store.ts";
import { createPolicyTestFixtures } from "./test-fixtures.ts";

const fixtures = createPolicyTestFixtures();

afterEach(async () => {
  vi.restoreAllMocks();
  await fixtures.cleanup();
});

it("preserves unrelated decisions during serialized updates", async () => {
  const directory = await fixtures.createDirectory();
  const configPath = join(await realpath(directory), "bash-tools.json");
  const projectPath = await realpath(directory);
  const store = createPolicyStoreForTesting({ configPath });
  const loaded = await store.load(directory);

  await Promise.all([
    store.recordDecisions(projectPath, [
      { kind: "environment", key: "FIRST", decision: "allow-project" },
    ]),
    store.recordDecisions(projectPath, [
      { kind: "environment", key: "SECOND", decision: "deny-project" },
    ]),
  ]);
  expect(findEnvironmentPolicyDecision(loaded, "FIRST")).toBe("unknown");
  const updated = await store.load(directory);
  expect(findEnvironmentPolicyDecision(updated, "FIRST")).toBe("allow-project");
  expect(findEnvironmentPolicyDecision(updated, "SECOND")).toBe("deny-project");
});

it.each(["lock", "temporary", "rename"] as const)(
  "keeps policy writes in the opened parent after a %s path replacement",
  async (replacementPoint) => {
    const directory = await fixtures.createDirectory();
    const policyRoot = await realpath(directory);
    const policyDirectory = join(policyRoot, "policy");
    const movedDirectory = join(policyRoot, `moved-policy-${replacementPoint}`);
    const targetDirectory = join(policyRoot, `target-${replacementPoint}`);
    await mkdir(policyDirectory);
    await mkdir(targetDirectory);
    const configPath = join(policyDirectory, "bash-tools.json");
    let swapped = false;
    const replaceParent = async () => {
      if (!swapped) {
        swapped = true;
        await rename(policyDirectory, movedDirectory);
        await symlink(targetDirectory, policyDirectory);
      }
    };
    const store = createPolicyStoreForTesting({
      configPath,
      fs: {
        writeFile: async (path, data, options) => {
          if (
            (replacementPoint === "lock" && path.endsWith(".lock")) ||
            (replacementPoint === "temporary" && path.endsWith(".tmp"))
          ) {
            await replaceParent();
          }
          await writeFile(path, data, options);
        },
        rename: async (source, destination) => {
          if (replacementPoint === "rename" && source.endsWith(".tmp")) {
            await replaceParent();
          }
          await rename(source, destination);
        },
      },
    });
    await store.recordDecisions(policyRoot, [
      { kind: "environment", key: "TOKEN", decision: "allow-project" },
    ]);
    expect(swapped).toBe(true);
    expect(
      JSON.parse(await readFile(join(movedDirectory, "bash-tools.json"), "utf8")),
    ).toMatchObject({ projects: { [policyRoot]: { allow: ["TOKEN"] } } });
    await expect(readFile(join(targetDirectory, "bash-tools.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("merges decisions from independent stores and cleans up the lock", async () => {
  const directory = await fixtures.createDirectory();
  const configPath = join(await realpath(directory), "bash-tools.json");
  const projectPath = await realpath(directory);
  const first = createPolicyStoreForTesting({ configPath });
  const second = createPolicyStoreForTesting({ configPath });

  await Promise.all([
    first.recordDecisions(projectPath, [
      { kind: "environment", key: "CONCURRENT", decision: "deny-global" },
    ]),
    second.recordDecisions(projectPath, [
      { kind: "environment", key: "CONCURRENT", decision: "allow-project" },
    ]),
  ]);

  const policy = await first.load(projectPath);
  expect(findEnvironmentPolicyDecision(policy, "CONCURRENT")).toBe("deny-global");
  expect(policy.document.environment.global.deny).toContain("CONCURRENT");
  expect(policy.document.environment.projects[projectPath]?.allow).toContain("CONCURRENT");
  await expect(stat(`${configPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
});

it("times out on an existing lock without reclaiming it", async () => {
  const directory = await fixtures.createDirectory();
  const configPath = join(await realpath(directory), "bash-tools.json");
  const lockPath = `${configPath}.lock`;
  const projectPath = await realpath(directory);
  await writeFile(lockPath, "held by another process");
  const started = Date.now();
  vi.spyOn(Date, "now")
    .mockReturnValueOnce(started)
    .mockReturnValue(started + 5_001);
  await expect(
    createPolicyStoreForTesting({ configPath }).recordDecisions(projectPath, [
      { kind: "environment", key: "LOCKED", decision: "allow-project" },
    ]),
  ).rejects.toThrow(/invalid or unreadable/iu);
  expect(await readFile(lockPath, "utf8")).toBe("held by another process");
}, 10_000);
