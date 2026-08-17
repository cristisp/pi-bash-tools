import { mkdir, readFile, realpath, rename, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEnvironmentPolicyStoreForTesting,
  findEnvironmentPolicyDecision,
} from "../policy.ts";
import { createPolicyTestFixtures } from "./test-fixtures.ts";

const fixtures = createPolicyTestFixtures();

afterEach(() => fixtures.cleanup());

describe("environment policy storage races", () => {
  it("preserves unrelated decisions during serialized updates", async () => {
    const directory = await fixtures.createDirectory();
    const configPath = join(await realpath(directory), "bash-tools.json");
    const projectPath = await realpath(directory);
    const store = createEnvironmentPolicyStoreForTesting({ configPath });
    const loaded = await store.load(directory);

    await Promise.all([
      store.recordDecision(projectPath, "FIRST", "allow-project"),
      store.recordDecision(projectPath, "SECOND", "deny-project"),
    ]);
    expect(findEnvironmentPolicyDecision(loaded, projectPath, "FIRST")).toBe("unknown");
    const updated = await store.load(directory);
    expect(findEnvironmentPolicyDecision(updated, projectPath, "FIRST")).toBe("allow-project");
    expect(findEnvironmentPolicyDecision(updated, projectPath, "SECOND")).toBe("deny-project");
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
      const store = createEnvironmentPolicyStoreForTesting({
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
      await store.recordDecision(policyRoot, "TOKEN", "allow-project");
      expect(swapped).toBe(true);
      expect(
        JSON.parse(await readFile(join(movedDirectory, "bash-tools.json"), "utf8")),
      ).toMatchObject({ projects: { [policyRoot]: { allow: ["TOKEN"] } } });
      await expect(
        readFile(join(targetDirectory, "bash-tools.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("merges decisions from independent stores and cleans up the lock", async () => {
    const directory = await fixtures.createDirectory();
    const configPath = join(await realpath(directory), "bash-tools.json");
    const projectPath = await realpath(directory);
    const first = createEnvironmentPolicyStoreForTesting({ configPath });
    const second = createEnvironmentPolicyStoreForTesting({ configPath });

    await Promise.all([
      first.recordDecision(projectPath, "CONCURRENT", "deny-global"),
      second.recordDecision(projectPath, "CONCURRENT", "allow-project"),
    ]);

    const policy = await first.load(projectPath);
    expect(findEnvironmentPolicyDecision(policy, projectPath, "CONCURRENT")).toBe("deny-global");
    expect(policy.global.deny).toContain("CONCURRENT");
    expect(policy.projects[projectPath]?.allow).toContain("CONCURRENT");
    await expect(stat(`${configPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("times out on an existing lock without reclaiming it", async () => {
    const directory = await fixtures.createDirectory();
    const configPath = join(await realpath(directory), "bash-tools.json");
    const lockPath = `${configPath}.lock`;
    const projectPath = await realpath(directory);
    await writeFile(lockPath, "held by another process");
    const store = createEnvironmentPolicyStoreForTesting({ configPath });

    const started = Date.now();
    await expect(store.recordDecision(projectPath, "LOCKED", "allow-project")).rejects.toThrow(
      /invalid or unreadable/iu,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(5_000);
    expect(await readFile(lockPath, "utf8")).toBe("held by another process");
  }, 10_000);
});
