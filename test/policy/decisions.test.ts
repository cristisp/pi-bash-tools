import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  applyEnvironmentPolicyDecision,
  applyFilesystemPolicyDecision,
  applyProjectCommandPolicyDecision,
  findEnvironmentPolicyDecision,
  findFilesystemPolicyDecision,
  findProjectCommandPolicyDecision,
} from "../../src/tools/policy/decisions.ts";
import { createEmptyCommandPolicy, parsePolicyDocument } from "../../src/tools/policy/document.ts";
import { createPolicyStoreForTesting } from "../../src/tools/policy/store.ts";
import type { LoadedPolicy, PolicyDocument } from "../../src/tools/policy/types.ts";
import { createPolicyTestFixtures } from "./test-fixtures.ts";

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

it("uses environment precedence from the loaded full policy", () => {
  let document = emptyDocument();
  document = applyEnvironmentPolicyDecision(document, projectPath, "HARD_DENY", "deny-global");
  document = applyEnvironmentPolicyDecision(document, projectPath, "PROJECT_DENY", "deny-project");
  document = applyEnvironmentPolicyDecision(document, projectPath, "GLOBAL_ALLOW", "allow-global");
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

it("uses filesystem path precedence and migrates the policy namespace", () => {
  let document = emptyDocument();
  document = applyFilesystemPolicyDecision(
    document,
    projectPath,
    "/tmp/filesystem-root",
    "allow-global",
  );
  document = applyFilesystemPolicyDecision(
    document,
    projectPath,
    "/tmp/filesystem-root/private",
    "deny-project",
  );
  const view = loaded(document);
  expect(document.version).toBe(4);
  expect(findFilesystemPolicyDecision(view, "/tmp/filesystem-root/public/file")).toBe(
    "allow-global",
  );
  expect(findFilesystemPolicyDecision(view, "/tmp/filesystem-root/private/file")).toBe(
    "deny-project",
  );
  expect(findFilesystemPolicyDecision(view, "/tmp/filesystem-root/private/file", "write")).toBe(
    "unknown",
  );
  expect(findFilesystemPolicyDecision(view, `${projectPath}/nested/file`, "read")).toBe(
    "allow-project",
  );
  expect(findFilesystemPolicyDecision(view, `${projectPath}/nested/file`, "write")).toBe(
    "allow-project",
  );
  expect(findFilesystemPolicyDecision(view, `${projectPath}/nested/file`, "move")).toBe("unknown");
  expect(findFilesystemPolicyDecision(view, `${projectPath}/nested/file`, "delete")).toBe(
    "unknown",
  );
  expect(findFilesystemPolicyDecision(view, "/tmp/unlisted")).toBe("unknown");
});

it("uses separate move and delete scopes", () => {
  let document = emptyDocument();
  document = applyFilesystemPolicyDecision(
    document,
    projectPath,
    "/tmp/mutable",
    "allow-global",
    "move",
  );
  document = applyFilesystemPolicyDecision(
    document,
    projectPath,
    "/tmp/mutable/private",
    "deny-project",
    "move",
  );
  document = applyFilesystemPolicyDecision(
    document,
    projectPath,
    "/tmp/removable",
    "allow-global",
    "delete",
  );
  const view = loaded(document);
  expect(findFilesystemPolicyDecision(view, "/tmp/mutable/file", "move")).toBe("allow-global");
  expect(findFilesystemPolicyDecision(view, "/tmp/mutable/private/file", "move")).toBe(
    "deny-project",
  );
  expect(findFilesystemPolicyDecision(view, "/tmp/removable/file", "delete")).toBe("allow-global");
  expect(findFilesystemPolicyDecision(view, "/tmp/removable/file", "write")).toBe("unknown");
});

it("provides an empty command namespace for new documents", () => {
  expect(createEmptyCommandPolicy()).toEqual({
    version: 1,
    global: { allow: [], deny: [] },
    projects: {},
  });
});
