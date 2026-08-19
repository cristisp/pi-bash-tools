import { chmod, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createPolicyStore, createPolicyStoreForTesting } from "./store.ts";
import { createPolicyTestFixtures } from "./test-fixtures.ts";

const fixtures = createPolicyTestFixtures();

afterEach(() => fixtures.cleanup());

describe("shared policy storage", () => {
  it("canonicalizes the project and writes decisions atomically with restrictive permissions", async () => {
    const directory = await fixtures.createDirectory();
    const configPath = join(await realpath(directory), "agent", "bash-tools.json");
    const projectPath = await realpath(directory);
    const store = createPolicyStoreForTesting({ configPath });

    const loaded = await store.load(join(directory, "."));
    expect(loaded.projectPath).toBe(projectPath);
    await store.recordDecisions(loaded.projectPath, [
      { kind: "environment", key: "TOKEN", decision: "allow-project" },
    ]);

    const saved = JSON.parse(await readFile(configPath, "utf8"));
    expect(saved).toMatchObject({ projects: { [projectPath]: { allow: ["TOKEN"] } } });
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "agent"))).mode & 0o777).toBe(0o700);
  });

  it("cleans the temporary policy file when chmod fails after creation", async () => {
    const directory = await fixtures.createDirectory();
    const policyRoot = await realpath(directory);
    const configPath = join(policyRoot, "bash-tools.json");
    let temporaryUnlinked = false;
    const store = createPolicyStoreForTesting({
      configPath,
      fs: {
        chmod: async (path) => {
          if (path.endsWith(".tmp")) {
            const error = Object.assign(new Error("chmod failed"), { code: "EACCES" });
            throw error;
          }
          await chmod(path, 0o600);
        },
        unlink: async (path) => {
          temporaryUnlinked ||= path.endsWith(".tmp");
          await unlink(path);
        },
      },
    });

    await expect(
      store.recordDecisions(policyRoot, [
        { kind: "environment", key: "CHMOD", decision: "allow-project" },
      ]),
    ).rejects.toThrow(/invalid or unreadable/iu);
    expect(temporaryUnlinked).toBe(true);
  });

  it("creates multiple missing policy parent directories from the root", async () => {
    const directory = await fixtures.createDirectory();
    const policyRoot = await realpath(directory);
    const configPath = join(policyRoot, "first", "second", "bash-tools.json");
    const store = createPolicyStoreForTesting({ configPath });

    await store.recordDecisions(policyRoot, [
      { kind: "environment", key: "NESTED", decision: "allow-project" },
    ]);

    expect((await stat(join(policyRoot, "first"))).isDirectory()).toBe(true);
    expect((await stat(join(policyRoot, "first", "second"))).isDirectory()).toBe(true);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      projects: { [policyRoot]: { allow: ["NESTED"] } },
    });
  });

  it("fails closed for unreadable policy files", async () => {
    const directory = await fixtures.createDirectory();
    const configPath = join(await realpath(directory), "bash-tools.json");
    await writeFile(configPath, '{"version":1,"global":{"allow":["SECRET"]}}');
    await chmod(configPath, 0o000);
    const store = createPolicyStoreForTesting({ configPath });
    try {
      await expect(store.load(directory)).rejects.toThrow(/invalid or unreadable/iu);
    } finally {
      await chmod(configPath, 0o600);
    }
  });

  it("uses only the fixed production policy path", () => {
    expect(createPolicyStore().configPath).toBe(join(getAgentDir(), "bash-tools.json"));
  });
});
