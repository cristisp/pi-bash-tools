import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  getProjectCommandDefinition,
  type ProjectCommandDefinition,
} from "../../../src/tools/project-command/definitions.ts";
import {
  readNodeProjectInfo,
  resolveNodeProjectCommand,
} from "../../../src/tools/project-command/node.ts";
import { createNodeProject, createNodeTestScope } from "./test-fixtures.ts";

const scope = createNodeTestScope();

afterEach(scope.cleanup);

function requireDefinition(commandId: string): ProjectCommandDefinition {
  const definition = getProjectCommandDefinition(commandId);
  if (definition === undefined) throw new Error(`missing ${commandId} definition`);
  return definition;
}

it("resolves each supported dependency-list form without requiring node_modules", async () => {
  const cases = [
    { manager: "npm", version: "10.0.0", args: ["ls", "--depth=0"] },
    { manager: "pnpm", version: "9.0.0", args: ["list", "--depth=0"] },
    { manager: "bun", version: "1.0.0", args: ["pm", "ls"] },
    { manager: "yarn", version: "1.22.22", args: ["list", "--depth=0"] },
  ] as const;
  await Promise.all(
    cases.map(async (entry) => {
      const directory = await createNodeProject(scope, {
        packageManager: `${entry.manager}@${entry.version}`,
      });
      const toolchain = join(directory, "toolchain");
      await mkdir(toolchain);
      const executable = join(toolchain, entry.manager);
      await writeFile(executable, "manager");
      await chmod(executable, 0o755);
      const resolved = await resolveNodeProjectCommand(
        requireDefinition("node_deps_list"),
        directory,
        { commandId: "node_deps_list" },
        {
          nodeExecutable: join(toolchain, "node"),
          approvedPackageManagerDirectories: [],
        },
      );
      expect(resolved).toMatchObject({
        executable,
        args: entry.args,
        fingerprintArgs: [entry.manager, ...entry.args],
      });
    }),
  );
});

it("fails closed for unsupported Yarn versions and omits the command from discovery", async () => {
  const directory = await createNodeProject(scope, { packageManager: "yarn@4.2.0" });
  const toolchain = join(directory, "toolchain");
  await mkdir(toolchain);
  const executable = join(toolchain, "yarn");
  await writeFile(executable, "yarn");
  await chmod(executable, 0o755);
  const options = {
    nodeExecutable: join(toolchain, "node"),
    approvedPackageManagerDirectories: [],
  };
  await expect(
    resolveNodeProjectCommand(
      requireDefinition("node_deps_list"),
      directory,
      { commandId: "node_deps_list" },
      options,
    ),
  ).rejects.toMatchObject({
    stage: "detection",
    code: "unsupported-yarn-version",
  });
  await expect(readNodeProjectInfo(directory, options)).resolves.toMatchObject({
    packageManager: { manager: "yarn", version: "4.2.0", executableAvailable: true },
    applicableCommands: ["node_project_info"],
  });
});
