import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  getProjectCommandDefinition,
  projectCommandIdentity,
} from "../../../src/tools/project-command/definitions.ts";
import { resolveNodeProjectCommand } from "../../../src/tools/project-command/node.ts";
import { createNodeProject, createNodeTestScope } from "./test-fixtures.ts";

const scope = createNodeTestScope();

afterEach(scope.cleanup);

describe("Node script command identity", () => {
  it("reports exact scripts and resolves fixed manager-mediated argv", async () => {
    const directory = await createNodeProject(scope, {
      packageManager: "npm@10.0.0",
      scripts: {
        test: "node runner.js",
        "test:coverage": "node runner.js --coverage",
        "test:e2e": "node runner.js e2e",
        build: "node build.js",
      },
    });
    await writeFile(join(directory, "runner.js"), "runner");
    const definition = getProjectCommandDefinition("node_test");
    if (definition === undefined) throw new Error("missing node_test definition");
    const resolved = await resolveNodeProjectCommand(definition, directory, {
      commandId: "node_test",
      paths: ["runner.js"],
    });
    expect(resolved.args).toEqual(["run", "test", "--", "runner.js"]);
    expect(resolved.script).toBe("node runner.js");
    const coverageDefinition = getProjectCommandDefinition("node_test_coverage");
    if (coverageDefinition === undefined) throw new Error("missing node_test_coverage definition");
    const coverageResolved = await resolveNodeProjectCommand(coverageDefinition, directory, {
      commandId: "node_test_coverage",
    });
    expect(coverageResolved.args).toEqual(["run", "test:coverage"]);
    expect(coverageResolved.script).toBe("node runner.js --coverage");
    const e2eDefinition = getProjectCommandDefinition("node_e2e");
    if (e2eDefinition === undefined) throw new Error("missing node_e2e definition");
    const e2eResolved = await resolveNodeProjectCommand(e2eDefinition, directory, {
      commandId: "node_e2e",
      paths: ["runner.js"],
      grep: "smoke",
      projects: ["chromium", "firefox"],
      workers: 1,
      retries: 2,
      headed: true,
      list: true,
    });
    expect(e2eResolved.args).toEqual([
      "run",
      "test:e2e",
      "--",
      "--grep",
      "smoke",
      "--project",
      "chromium",
      "--project",
      "firefox",
      "--workers",
      "1",
      "--retries",
      "2",
      "--headed",
      "--list",
      "runner.js",
    ]);
    expect(e2eResolved.script).toBe("node runner.js e2e");
    expect(resolved.executable.startsWith("/")).toBe(true);
    const withoutPath = await resolveNodeProjectCommand(definition, directory, {
      commandId: "node_test",
    });
    expect(projectCommandIdentity(definition, resolved)).toEqual(
      projectCommandIdentity(definition, withoutPath),
    );
    const changed = await createNodeProject(scope, {
      packageManager: "npm@10.0.0",
      scripts: { test: "node changed.js" },
    });
    const changedResolved = await resolveNodeProjectCommand(definition, changed, {
      commandId: "node_test",
    });
    expect(projectCommandIdentity(definition, changedResolved)).not.toEqual(
      projectCommandIdentity(definition, withoutPath),
    );
  });
});
