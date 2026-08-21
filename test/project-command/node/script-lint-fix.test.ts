import { afterEach, describe, expect, it } from "vitest";
import { getProjectCommandDefinition } from "../../../src/tools/project-command/definitions.ts";
import {
  readNodeProjectInfo,
  resolveNodeProjectCommand,
} from "../../../src/tools/project-command/node.ts";
import { createNodeProject, createNodeTestScope } from "./test-fixtures.ts";

const scope = createNodeTestScope();

afterEach(scope.cleanup);

describe("Node lint fix script resolution", () => {
  it("reports and resolves only the exact lint:fix script", async () => {
    const directory = await createNodeProject(scope, {
      packageManager: "npm@10.0.0",
      scripts: {
        lint: "node lint.js",
        "lint:fix": "node lint-fix.js",
        "lint:fix:extra": "node extra.js",
        linter: "node linter.js",
      },
    });
    await expect(readNodeProjectInfo(directory)).resolves.toMatchObject({
      scripts: ["lint", "lint:fix", "lint:fix:extra", "linter"],
      applicableCommands: ["node_project_info", "node_deps_list", "node_lint", "node_lint_fix"],
    });
    const definition = getProjectCommandDefinition("node_lint_fix");
    if (definition === undefined) throw new Error("missing node_lint_fix definition");
    const resolved = await resolveNodeProjectCommand(definition, directory, {
      commandId: "node_lint_fix",
    });
    expect(resolved).toMatchObject({
      args: ["run", "lint:fix"],
      fingerprintArgs: ["<package-manager>", "run", "lint:fix"],
      script: "node lint-fix.js",
    });
    expect(resolved.executable.startsWith("/")).toBe(true);
  });
});
