import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyEnvironmentPolicyDecision,
  applyProjectCommandPolicyDecision,
  findEnvironmentPolicyDecision,
  findProjectCommandPolicyDecision,
} from "./decisions.ts";
import { createEmptyCommandPolicy, parsePolicyDocument } from "./document.ts";
import { createPolicyStoreForTesting } from "./store.ts";
import { createPolicyTestFixtures } from "./test-fixtures.ts";
import type { LoadedPolicy, PolicyDocument } from "./types.ts";

const fixtures = createPolicyTestFixtures();

afterEach(() => fixtures.cleanup());

const projectPath = "/tmp/project-command-policy";
const identity = { commandId: "workspace_path", fingerprint: "a".repeat(64) };
const otherIdentity = { commandId: "workspace_path", fingerprint: "b".repeat(64) };

function loaded(document: PolicyDocument, path = projectPath): LoadedPolicy {
  return {
    projectPath: path,
    confirmationTimeoutMs: document.environment.confirmationTimeoutMs,
    document,
  };
}

function emptyDocument(): PolicyDocument {
  return parsePolicyDocument(JSON.stringify({ version: 1 }));
}

describe("shared policy decisions", () => {
  it("uses environment precedence from the loaded full policy", () => {
    let document = emptyDocument();
    document = applyEnvironmentPolicyDecision(document, projectPath, "HARD_DENY", "deny-global");
    document = applyEnvironmentPolicyDecision(
      document,
      projectPath,
      "PROJECT_DENY",
      "deny-project",
    );
    document = applyEnvironmentPolicyDecision(
      document,
      projectPath,
      "GLOBAL_ALLOW",
      "allow-global",
    );
    document = applyEnvironmentPolicyDecision(
      document,
      projectPath,
      "PROJECT_ALLOW",
      "allow-project",
    );
    const view = loaded(document);
    expect(findEnvironmentPolicyDecision(view, "HARD_DENY")).toBe("deny-global");
    expect(findEnvironmentPolicyDecision(view, "PROJECT_DENY")).toBe("deny-project");
    expect(findEnvironmentPolicyDecision(view, "GLOBAL_ALLOW")).toBe("allow-global");
    expect(findEnvironmentPolicyDecision(view, "PROJECT_ALLOW")).toBe("allow-project");
    expect(findEnvironmentPolicyDecision(view, "UNKNOWN")).toBe("unknown");
  });

  it("uses command precedence and rejects unsafe global approvals", () => {
    const versionTwo = applyProjectCommandPolicyDecision(
      emptyDocument(),
      projectPath,
      identity,
      "allow-project",
      true,
    );
    const view = loaded(versionTwo);
    expect(findProjectCommandPolicyDecision(view, identity, true)).toBe("allow-project");
    expect(findProjectCommandPolicyDecision(view, identity, false)).toBe("allow-project");
    expect(findProjectCommandPolicyDecision(view, otherIdentity, true)).toBe("unknown");
    expect(() =>
      applyProjectCommandPolicyDecision(
        emptyDocument(),
        projectPath,
        identity,
        "allow-global",
        false,
      ),
    ).toThrow(/invalid or unreadable/iu);
  });

  it("migrates command decisions while preserving environment data", () => {
    const document = parsePolicyDocument(
      JSON.stringify({
        version: 1,
        confirmationTimeoutMs: 321,
        global: { allow: ["PRESENT"], deny: [] },
        projects: { [projectPath]: { allow: ["PROJECT"], deny: [] } },
      }),
    );
    const migrated = applyProjectCommandPolicyDecision(
      document,
      projectPath,
      identity,
      "allow-project",
      true,
    );
    expect(migrated.version).toBe(2);
    if (migrated.version !== 2) {
      throw new Error("expected version two document");
    }
    expect(migrated.environment).toEqual(document.environment);
    expect(migrated.projectCommands.projects[projectPath]?.allow).toEqual([identity]);
  });

  it("persists cross-scope environment decisions while rejecting same-scope opposites", async () => {
    const directory = await fixtures.createDirectory();
    const configPath = join(await realpath(directory), "bash-tools.json");
    const canonicalPath = await realpath(directory);
    const store = createPolicyStoreForTesting({ configPath });
    await store.recordDecisions(canonicalPath, [
      { kind: "environment", key: "GLOBAL_HARD_DENY", decision: "deny-global" },
      { kind: "environment", key: "GLOBAL_HARD_DENY", decision: "allow-project" },
      { kind: "environment", key: "PROJECT_DENY", decision: "allow-global" },
      { kind: "environment", key: "PROJECT_DENY", decision: "deny-project" },
      { kind: "environment", key: "IDEMPOTENT", decision: "allow-global" },
    ]);
    await expect(
      store.recordDecisions(canonicalPath, [
        { kind: "environment", key: "IDEMPOTENT", decision: "deny-global" },
      ]),
    ).rejects.toThrow(/invalid or unreadable/iu);
    const policy = await store.load(canonicalPath);
    expect(findEnvironmentPolicyDecision(policy, "GLOBAL_HARD_DENY")).toBe("deny-global");
    expect(findEnvironmentPolicyDecision(policy, "PROJECT_DENY")).toBe("deny-project");
  });

  it("keeps v2 command decisions visible while applying environment updates", async () => {
    const directory = await fixtures.createDirectory();
    const configPath = join(await realpath(directory), "bash-tools.json");
    const canonicalPath = await realpath(directory);
    const store = createPolicyStoreForTesting({ configPath });
    await store.recordDecisions(canonicalPath, [
      { kind: "project-command", identity, decision: "allow-project", globalSafe: true },
    ]);
    await store.recordDecisions(canonicalPath, [
      { kind: "environment", key: "NEW_KEY", decision: "allow-project" },
    ]);
    const policy = await store.load(canonicalPath);
    expect(findProjectCommandPolicyDecision(policy, identity, true)).toBe("allow-project");
    expect(findEnvironmentPolicyDecision(policy, "NEW_KEY")).toBe("allow-project");
    expect(policy.document.version).toBe(2);
  });

  it("provides an empty command namespace for new documents", () => {
    expect(createEmptyCommandPolicy()).toEqual({
      version: 1,
      global: { allow: [], deny: [] },
      projects: {},
    });
  });
});
