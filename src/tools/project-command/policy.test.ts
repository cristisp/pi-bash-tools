import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectCommandPolicyStoreForTesting } from "./policy.ts";
import { findProjectCommandPolicyDecision } from "./policy-decisions.ts";
import { getProjectCommandDefinitions, projectCommandIdentity } from "./definitions.ts";
import { parsePolicyDocument } from "../environment/policy/document.ts";
import { createEnvironmentPolicyStoreForTesting } from "../environment/policy.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("project command policy storage", () => {
  it("parses v1 environment documents and migrates command writes to v2", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bash-tools-project-command-policy-"));
    directories.push(directory);
    const projectPath = await realpath(directory);
    const configPath = join(projectPath, "bash-tools.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        confirmationTimeoutMs: 321,
        global: { allow: ["PRESENT"], deny: [] },
        projects: { [projectPath]: { allow: ["PROJECT"], deny: [] } },
      }),
    );
    const store = createProjectCommandPolicyStoreForTesting({ configPath });
    const loaded = await store.load(join(directory, "."));
    expect(loaded.projectPath).toBe(projectPath);
    expect(loaded.confirmationTimeoutMs).toBe(321);
    const identity = projectCommandIdentity(getProjectCommandDefinitions()[0]);
    await store.recordDecision(projectPath, identity, "allow-project", undefined, true);

    const saved = parsePolicyDocument(await readFile(configPath, "utf8"));
    expect(saved.version).toBe(2);
    if (saved.version !== 2) {
      throw new Error("expected a version two policy document");
    }
    expect(saved.environment).toEqual({
      version: 1,
      confirmationTimeoutMs: 321,
      global: { allow: ["PRESENT"], deny: [] },
      projects: { [projectPath]: { allow: ["PROJECT"], deny: [] } },
    });
    expect(saved.projectCommands.version).toBe(1);
    expect(saved.projectCommands.projects[projectPath]?.allow).toEqual([identity]);
    await createEnvironmentPolicyStoreForTesting({ configPath }).recordDecision(
      projectPath,
      "NEW_ENVIRONMENT_KEY",
      "allow-project",
    );
    const afterEnvironmentWrite = parsePolicyDocument(await readFile(configPath, "utf8"));
    expect(afterEnvironmentWrite.version).toBe(2);
    if (afterEnvironmentWrite.version !== 2) {
      throw new Error("expected a version two policy document");
    }
    expect(afterEnvironmentWrite.projectCommands.projects[projectPath]?.allow).toEqual([identity]);
    expect(
      findProjectCommandPolicyDecision(
        { version: 1, global: loaded.global, projects: { [projectPath]: loaded.project } },
        projectPath,
        identity,
        true,
      ),
    ).toBe("unknown");
    expect(parsePolicyDocument(await readFile(configPath, "utf8"))).toMatchObject({
      version: 2,
      environment: { version: 1 },
      projectCommands: { version: 1 },
    });
  });

  it("fails closed for malformed command namespaces", () => {
    const malformed = [
      { version: 2, environment: { version: 1 }, projectCommands: { version: 2 } },
      { version: 2, environment: { version: 1 }, projectCommands: { version: 1, extra: true } },
      {
        version: 2,
        environment: { version: 1 },
        projectCommands: {
          version: 1,
          global: { allow: [{ commandId: "workspace_path", fingerprint: "old" }] },
        },
      },
    ];
    for (const value of malformed) {
      expect(() => parsePolicyDocument(JSON.stringify(value))).toThrow(/invalid or unreadable/iu);
    }
  });
});
