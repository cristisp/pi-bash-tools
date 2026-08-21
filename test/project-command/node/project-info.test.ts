import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readNodeProjectInfo } from "../../../src/tools/project-command/node.ts";
import { createNodeProject, createNodeTestScope } from "./test-fixtures.ts";

const scope = createNodeTestScope();

afterEach(scope.cleanup);

describe("Node project information", () => {
  it("reports a missing manifest without defaulting to npm", async () => {
    const directory = scope.track(await mkdtemp(join(tmpdir(), "bash-tools-node-missing-")));
    await expect(readNodeProjectInfo(directory)).resolves.toMatchObject({
      nodeVersion: process.version,
      manifestPresent: false,
      packageManager: null,
      scripts: [],
      applicableCommands: ["node_project_info"],
    });
  });

  it("reports Fallow commands when the project-local binary is available", async () => {
    const directory = await createNodeProject(scope, { scripts: {} });
    await mkdir(join(directory, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(directory, "node_modules", ".bin", "fallow"), "fallow");
    await expect(readNodeProjectInfo(directory)).resolves.toMatchObject({
      applicableCommands: [
        "node_project_info",
        "node_deps_list",
        "fallow_dead_code",
        "fallow_dupes",
        "fallow_health",
        "fallow_audit",
        "fallow_list_entry_points",
        "fallow_list_boundaries",
      ],
    });
  });
});
