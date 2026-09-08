import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getProjectCommandDefinition,
  type ProjectCommandDefinition,
} from "../../src/tools/project-command/definitions.ts";
import { createNodeProjectRelevantInputDiscovery } from "../../src/tools/project-command/node/relevant-inputs.ts";
import {
  canonicalProjectCommandRelevantInputs,
  type ProjectCommandRelevantInputDiscovery,
} from "../../src/tools/project-command/relevant-inputs.ts";
import { createNodeProject, createNodeTestScope } from "./node/test-fixtures.ts";

const scope = createNodeTestScope();

afterEach(scope.cleanup);

function definition(commandId: string): ProjectCommandDefinition {
  const result = getProjectCommandDefinition(commandId);
  if (result === undefined) throw new Error(`missing ${commandId}`);
  return result;
}

describe("project command relevant inputs", () => {
  it("canonicalizes immutable file and value records in deterministic order", () => {
    const inputs = canonicalProjectCommandRelevantInputs(
      [
        { kind: "file", path: "z.config.ts" },
        { kind: "file", path: "package.json" },
      ],
      [
        { kind: "value", name: "test-paths", value: '["src"]' },
        { kind: "value", name: "package-script", value: "hash" },
      ],
    );

    expect(inputs).toEqual({
      files: [
        { kind: "file", path: "package.json" },
        { kind: "file", path: "z.config.ts" },
      ],
      values: [
        { kind: "value", name: "package-script", value: "hash" },
        { kind: "value", name: "test-paths", value: '["src"]' },
      ],
    });
    expect(Object.isFrozen(inputs)).toBe(true);
    expect(Object.isFrozen(inputs.files)).toBe(true);
    expect(Object.isFrozen(inputs.values)).toBe(true);
    expect(Object.isFrozen(inputs.files[0])).toBe(true);
    expect(Object.isFrozen(inputs.values[0])).toBe(true);
  });

  it("discovers the manifest, applicable lockfiles, selected script hash, paths, and config", async () => {
    const projectPath = await createNodeProject(scope, {
      packageManager: "npm@10.0.0",
      scripts: { test: "vitest run", lint: "oxlint" },
    });
    await writeFile(join(projectPath, "package-lock.json"), "{}");
    await writeFile(join(projectPath, "vitest.config.ts"), "export default {};");
    const nodeTest = {
      ...definition("node_test"),
      relevantInputConfigPaths: ["vitest.config.ts"],
    };

    const result = await createNodeProjectRelevantInputDiscovery({
      fileSystem: { readFile, stat },
    }).discover({
      definition: nodeTest,
      projectPath,
      parameters: { commandId: "node_test", paths: ["tests/smoke.test.ts"] },
    });

    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    expect(result.inputs.files).toEqual([
      { kind: "file", path: "package-lock.json" },
      { kind: "file", path: "package.json" },
      { kind: "file", path: "vitest.config.ts" },
    ]);
    expect(result.inputs.values).toEqual([
      {
        kind: "value",
        name: "explicit-test-paths",
        value: '["tests/smoke.test.ts"]',
      },
      expect.objectContaining({
        kind: "value",
        name: "package-script-hash:test",
        value: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    ]);
  });

  it("keeps non-script Node commands complete when a package manifest is present", async () => {
    const projectPath = await createNodeProject(scope, {
      packageManager: "npm@10.0.0",
      scripts: { test: "vitest run" },
    });
    const results = await Promise.all(
      ["node_project_info", "node_deps_list"].map((commandId) =>
        createNodeProjectRelevantInputDiscovery({
          fileSystem: { readFile, stat },
        }).discover({
          definition: definition(commandId),
          projectPath,
          parameters: { commandId },
        }),
      ),
    );
    for (const result of results) {
      expect(result.status).toBe("complete");
    }
  });

  it("does not return a partial basis for missing scripts or manifest reads", async () => {
    const projectPath = await createNodeProject(scope, { scripts: {} });
    const missingScript = await createNodeProjectRelevantInputDiscovery().discover({
      definition: definition("node_test"),
      projectPath,
      parameters: { commandId: "node_test" },
    });
    expect(missingScript).toEqual({ status: "incomplete", reason: "missing-package-script" });
    expect(missingScript).not.toHaveProperty("inputs");

    const error = Object.assign(new Error("read failed"), { code: "EIO" });
    const readFailure = await createNodeProjectRelevantInputDiscovery({
      fileSystem: {
        readFile: async () => {
          throw error;
        },
        stat,
      },
    }).discover({ definition: definition("node_test"), projectPath });
    expect(readFailure.status).toBe("error");
    expect(readFailure).not.toHaveProperty("inputs");
  });

  it("returns an error rather than a partial basis when an explicit config probe fails", async () => {
    const projectPath = await createNodeProject(scope, {
      packageManager: "npm@10.0.0",
      scripts: { test: "vitest run" },
    });
    const configError = Object.assign(new Error("config probe failed"), { code: "EIO" });
    const result = await createNodeProjectRelevantInputDiscovery({
      fileSystem: {
        readFile,
        stat: async (path) => {
          if (path.endsWith("vitest.config.ts")) throw configError;
          return stat(path);
        },
      },
    }).discover({
      definition: { ...definition("node_test"), relevantInputConfigPaths: ["vitest.config.ts"] },
      projectPath,
    });
    expect(result.status).toBe("error");
    expect(result).not.toHaveProperty("inputs");
  });

  it("keeps discovery injectable and gates workspace snapshots by definition approval", async () => {
    const projectPath = await createNodeProject(scope, { scripts: {} });
    const discovery = createNodeProjectRelevantInputDiscovery();
    const injected: ProjectCommandRelevantInputDiscovery = {
      discover: async () => ({
        status: "incomplete",
        reason: "injected",
      }),
    };
    expect(
      await injected.discover({ definition: definition("workspace_path"), projectPath }),
    ).toEqual({
      status: "incomplete",
      reason: "injected",
    });

    const unapproved = await discovery.discover({
      kind: "workspace-snapshot",
      definition: { ...definition("workspace_path"), reusePolicy: "workspace-snapshot" },
      projectPath,
    });
    expect(unapproved).toEqual({ status: "incomplete", reason: "workspace-snapshot-not-approved" });

    const approved = await discovery.discover({
      kind: "workspace-snapshot",
      definition: {
        ...definition("workspace_path"),
        reusePolicy: "workspace-snapshot",
        workspaceSnapshotApproved: true,
      },
      projectPath,
    });
    expect(approved).toEqual({
      status: "incomplete",
      reason: "workspace-snapshot-requires-snapshot-discoverer",
    });
  });
});
