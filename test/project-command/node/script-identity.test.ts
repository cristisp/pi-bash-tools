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
    const variantResolved = await resolveNodeProjectCommand(definition, directory, {
      commandId: "node_test",
      variant: "coverage",
    });
    expect(variantResolved.args).toEqual(["run", "test:coverage"]);
    expect(variantResolved.script).toBe("node runner.js --coverage");
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
