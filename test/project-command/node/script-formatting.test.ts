import { afterEach, describe, expect, it } from "vitest";
import { getProjectCommandDefinition } from "../../../src/tools/project-command/definitions.ts";
import {
  readNodeProjectInfo,
  resolveNodeProjectCommand,
} from "../../../src/tools/project-command/node.ts";
import { createNodeProject, createNodeTestScope } from "./test-fixtures.ts";

const scope = createNodeTestScope();

afterEach(scope.cleanup);

describe("Node formatting script resolution", () => {
  it("reports and resolves only the exact formatting scripts", async () => {
    const directory = await createNodeProject(scope, {
      packageManager: "npm@10.0.0",
      scripts: {
        "format:check": "node check-format.js",
        format: "node write-format.js",
        "format:check:extra": "node extra.js",
      },
    });
    await expect(readNodeProjectInfo(directory)).resolves.toMatchObject({
      scripts: ["format", "format:check", "format:check:extra"],
      applicableCommands: [
        "node_project_info",
        "node_deps_list",
        "node_format_check",
        "node_format_write",
      ],
    });

    const checkDefinition = getProjectCommandDefinition("node_format_check");
    const writeDefinition = getProjectCommandDefinition("node_format_write");
    if (checkDefinition === undefined || writeDefinition === undefined) {
      throw new Error("missing formatting definition");
    }
    const check = await resolveNodeProjectCommand(checkDefinition, directory, {
      commandId: "node_format_check",
    });
    const write = await resolveNodeProjectCommand(writeDefinition, directory, {
      commandId: "node_format_write",
    });
    expect(check).toMatchObject({
      args: ["run", "format:check"],
      fingerprintArgs: ["<package-manager>", "run", "format:check"],
      script: "node check-format.js",
    });
    expect(write).toMatchObject({
      args: ["run", "format"],
      fingerprintArgs: ["<package-manager>", "run", "format"],
      script: "node write-format.js",
    });
  });
});
