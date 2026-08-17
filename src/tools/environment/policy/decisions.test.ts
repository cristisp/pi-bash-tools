import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEnvironmentPolicyStoreForTesting } from "../policy.ts";
import { findEnvironmentPolicyDecision } from "./decisions.ts";
import { createPolicyTestFixtures } from "./test-fixtures.ts";

const fixtures = createPolicyTestFixtures();

afterEach(() => fixtures.cleanup());

describe("environment policy decisions", () => {
  it("persists cross-scope decisions while rejecting same-scope opposites", async () => {
    const directory = await fixtures.createDirectory();
    const configPath = join(await realpath(directory), "bash-tools.json");
    const projectPath = await realpath(directory);
    const store = createEnvironmentPolicyStoreForTesting({ configPath });

    await store.recordDecision(projectPath, "GLOBAL_HARD_DENY", "deny-global");
    await store.recordDecision(projectPath, "GLOBAL_HARD_DENY", "allow-project");
    await store.recordDecision(projectPath, "PROJECT_DENY", "allow-global");
    await store.recordDecision(projectPath, "PROJECT_DENY", "deny-project");
    await store.recordDecision(projectPath, "IDEMPOTENT", "allow-global");
    await store.recordDecision(projectPath, "IDEMPOTENT", "allow-global");

    await expect(store.recordDecision(projectPath, "IDEMPOTENT", "deny-global")).rejects.toThrow(
      /invalid or unreadable/iu,
    );
    await expect(
      store.recordDecision(projectPath, "PROJECT_DENY", "allow-project"),
    ).rejects.toThrow(/invalid or unreadable/iu);

    const policy = await store.load(projectPath);
    expect(findEnvironmentPolicyDecision(policy, projectPath, "GLOBAL_HARD_DENY")).toBe(
      "deny-global",
    );
    expect(findEnvironmentPolicyDecision(policy, projectPath, "PROJECT_DENY")).toBe("deny-project");
    expect(policy.projects[projectPath]).toEqual({
      allow: ["GLOBAL_HARD_DENY"],
      deny: ["PROJECT_DENY"],
    });
  });
});
