import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readNodeProjectInfo } from "../../../src/tools/project-command/node.ts";
import { createNodeProject, createNodeTestScope } from "./test-fixtures.ts";

const scope = createNodeTestScope();

afterEach(scope.cleanup);

describe("Node Fallow project probing", () => {
  it("reports Fallow only for a safe in-root binary", async () => {
    const fallowCommandIds = [
      "fallow_dead_code",
      "fallow_dupes",
      "fallow_health",
      "fallow_audit",
      "fallow_list_entry_points",
      "fallow_list_boundaries",
    ];
    const missingProject = await createNodeProject(scope, { scripts: {} });
    await expect(readNodeProjectInfo(missingProject)).resolves.toMatchObject({
      applicableCommands: ["node_project_info", "node_deps_list"],
    });

    const escapingProject = await createNodeProject(scope, { scripts: {} });
    const outside = await createNodeProject(scope, { scripts: {} });
    await writeFile(join(outside, "fallow"), "escaping");
    await mkdir(join(escapingProject, "node_modules", ".bin"), { recursive: true });
    await symlink(join(outside, "fallow"), join(escapingProject, "node_modules", ".bin", "fallow"));
    await expect(readNodeProjectInfo(escapingProject)).resolves.toMatchObject({
      applicableCommands: ["node_project_info", "node_deps_list"],
    });

    const danglingProject = await createNodeProject(scope, { scripts: {} });
    await mkdir(join(danglingProject, "node_modules", ".bin"), { recursive: true });
    await symlink(
      join(danglingProject, "missing-fallow"),
      join(danglingProject, "node_modules", ".bin", "fallow"),
    );
    await expect(readNodeProjectInfo(danglingProject)).resolves.toMatchObject({
      applicableCommands: ["node_project_info", "node_deps_list"],
    });

    const nonFileProject = await createNodeProject(scope, { scripts: {} });
    await mkdir(join(nonFileProject, "node_modules", ".bin", "fallow"), { recursive: true });
    await expect(readNodeProjectInfo(nonFileProject)).resolves.toMatchObject({
      applicableCommands: ["node_project_info", "node_deps_list"],
    });

    const validProject = await createNodeProject(scope, { scripts: {} });
    await mkdir(join(validProject, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(validProject, "node_modules", ".bin", "fallow"), "fallow");
    await expect(readNodeProjectInfo(validProject)).resolves.toMatchObject({
      applicableCommands: ["node_project_info", "node_deps_list", ...fallowCommandIds],
    });
  });
});
