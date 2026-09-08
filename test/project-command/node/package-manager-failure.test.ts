import { stat } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getProjectCommandDefinition,
  type ProjectCommandDefinition,
} from "../../../src/tools/project-command/definitions.ts";
import { resolveNodeProjectCommand } from "../../../src/tools/project-command/node.ts";
import { findPackageManagerExecutable } from "../../../src/tools/project-command/resolution.ts";
import { createNodeProject, createNodeTestScope } from "./test-fixtures.ts";

const scope = createNodeTestScope();

afterEach(scope.cleanup);

function requireDefinition(commandId: string): ProjectCommandDefinition {
  const definition = getProjectCommandDefinition(commandId);
  if (definition === undefined) throw new Error(`missing ${commandId} definition`);
  return definition;
}

describe("Node package-manager failures", () => {
  it("keeps an unavailable manager distinct from dependency-list command results", async () => {
    const directory = await createNodeProject(scope, { packageManager: "pnpm@9.0.0" });
    await expect(
      resolveNodeProjectCommand(
        requireDefinition("node_deps_list"),
        directory,
        { commandId: "node_deps_list" },
        {
          nodeExecutable: join(directory, "missing-node"),
          approvedPackageManagerDirectories: [],
        },
      ),
    ).rejects.toMatchObject({
      stage: "binary-resolution",
      code: "package-manager-executable-unavailable",
    });
  });

  it("only checks fixed absolute manager candidates", async () => {
    const checked: string[] = [];
    const executableStats = await stat(process.execPath);
    const directoryStats = await stat(process.cwd());
    const executable = await findPackageManagerExecutable("npm", {
      nodeExecutable: "/active/node/bin/node",
      approvedDirectories: ["/approved/bin"],
      fileSystem: {
        stat: async (path) => {
          checked.push(path);
          return path === "/approved/bin/npm" ? executableStats : directoryStats;
        },
      },
    });
    expect(executable).toBe("/approved/bin/npm");
    expect(checked).toEqual(["/active/node/bin/npm", "/approved/bin/npm"]);
  });
});
