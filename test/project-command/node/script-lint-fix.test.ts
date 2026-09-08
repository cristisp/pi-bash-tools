import { afterEach, describe, expect, it } from "vitest";

import { getProjectCommandDefinition } from "../../../src/tools/project-command/definitions.ts";
import {
  readNodeProjectInfo,
  resolveNodeProjectCommand,
} from "../../../src/tools/project-command/node.ts";
import { createNodeProject, createNodeTestScope } from "./test-fixtures.ts";

const scope = createNodeTestScope();

afterEach(scope.cleanup);

describe("Node lint variant resolution", () => {
  it("reports and resolves the configured lint:fix variant", async () => {
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
      applicableCommands: ["node_project_info", "node_deps_list", "node_lint"],
    });
    const definition = getProjectCommandDefinition("node_lint");
    if (definition === undefined) throw new Error("missing node_lint definition");
    const resolved = await resolveNodeProjectCommand(definition, directory, {
      commandId: "node_lint",
      variant: "fix",
    });
    expect(resolved).toMatchObject({
      args: ["run", "lint:fix"],
      fingerprintArgs: ["<package-manager>", "run", "lint"],
      script: "node lint-fix.js",
    });
    expect(resolved.executable.startsWith("/")).toBe(true);
  });
});
