import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEnvironmentToolForTesting,
  type EnvironmentToolContext,
} from "../../src/tools/environment/environment-tool.ts";
import { createPolicyStoreForTesting } from "../../src/tools/policy/store.ts";

const directories: string[] = [];

function context(cwd: string, mode: EnvironmentToolContext["mode"]): EnvironmentToolContext {
  return {
    cwd,
    mode,
    hasUI: false,
    signal: undefined,
    ui: { select: async () => undefined },
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("environment tool with a real user policy file", () => {
  it("uses the canonical workspace identity and never reads repository-local files", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-tools-environment-integration-"));
    directories.push(root);
    const project = join(root, "project");
    const alias = join(root, "alias");
    const configPath = join(await realpath(root), "user", "bash-tools.json");
    await writeFile(join(root, "repository-local-policy.json"), "not a policy");
    await mkdir(project);
    try {
      await symlink(project, alias, "junction");
    } catch {
      return;
    }
    const canonicalProject = await realpath(project);
    await mkdir(join(root, "user"), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        projects: { [canonicalProject]: { allow: ["INTEGRATION_KEY"] } },
      }),
    );

    const tool = createEnvironmentToolForTesting({
      configPath,
      environment: { INTEGRATION_KEY: "integration-value" },
    });
    const response = await tool.execute(
      "integration",
      { keys: ["INTEGRATION_KEY"] },
      undefined,
      undefined,
      context(alias, "print"),
    );
    expect(response.details.values).toEqual({ INTEGRATION_KEY: "integration-value" });
    expect(await realpath(alias)).toBe(canonicalProject);
    expect(await readFile(configPath, "utf8")).toContain(canonicalProject);
  });

  it("round-trips a real policy decision without exposing an absent value", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bash-tools-environment-integration-"));
    directories.push(directory);
    const configPath = join(await realpath(directory), "policy", "bash-tools.json");
    const store = createPolicyStoreForTesting({ configPath });
    const loaded = await store.load(directory);
    await store.recordDecision(loaded.projectPath, "PRESENT", "allow-project");
    await store.recordDecision(loaded.projectPath, "ABSENT", "allow-project");
    const tool = createEnvironmentToolForTesting({
      configPath,
      environment: { PRESENT: "", ABSENT: undefined },
    });
    const response = await tool.execute(
      "integration",
      { keys: ["PRESENT", "ABSENT"] },
      undefined,
      undefined,
      context(directory, "json"),
    );
    expect(response.details.values).toEqual({ PRESENT: "", ABSENT: null });
  });
});
