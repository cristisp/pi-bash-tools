import { afterEach, describe, expect, it } from "vitest";
import { readNodeProjectInfo } from "../../../src/tools/project-command/node.ts";
import { createNodeProject, createNodeTestScope } from "./test-fixtures.ts";

const scope = createNodeTestScope();

afterEach(scope.cleanup);

describe("Node script applicability filtering", () => {
  it("does not report lint fix for similarly named scripts", async () => {
    const directory = await createNodeProject(scope, {
      packageManager: "npm@10.0.0",
      scripts: { "lint:fixer": "node lint-fixer.js", lintfix: "node lintfix.js" },
    });
    await expect(readNodeProjectInfo(directory)).resolves.toMatchObject({
      scripts: ["lint:fixer", "lintfix"],
      applicableCommands: ["node_project_info", "node_deps_list"],
    });
  });

  it("does not report formatting commands for similarly named scripts", async () => {
    const directory = await createNodeProject(scope, {
      packageManager: "npm@10.0.0",
      scripts: { "format:checker": "node check-format.js", formatter: "node format.js" },
    });
    await expect(readNodeProjectInfo(directory)).resolves.toMatchObject({
      scripts: ["format:checker", "formatter"],
      applicableCommands: ["node_project_info", "node_deps_list"],
    });
  });
});
