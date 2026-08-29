import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { getProjectCommandDefinition } from "../../../src/tools/project-command/definitions.ts";
import { resolveNodeProjectCommand } from "../../../src/tools/project-command/node.ts";
import { createNodeProject, createNodeTestScope } from "./test-fixtures.ts";

const scope = createNodeTestScope();

afterEach(scope.cleanup);

it("does not probe Fallow while resolving an exact Node script", async () => {
  const directory = await createNodeProject(scope, {
    packageManager: "npm@10.0.0",
    scripts: { "lint:fix": "node lint-fix.js" },
  });
  await mkdir(join(directory, "node_modules", ".bin"), { recursive: true });
  await writeFile(join(directory, "node_modules", ".bin", "fallow"), "fallow");
  const realpathProbe = vi.fn(async (path: string) => await realpath(path));
  const lstatProbe = vi.fn(async (path: string) => await lstat(path));
  const definition = getProjectCommandDefinition("node_lint");
  if (definition === undefined) throw new Error("missing node_lint definition");

  const resolved = await resolveNodeProjectCommand(
    definition,
    directory,
    { commandId: "node_lint", variant: "fix" },
    {
      fileSystem: {
        readFile: (path, encoding) => readFile(path, encoding),
        stat,
        realpath: realpathProbe,
        lstat: lstatProbe,
      },
    },
  );

  expect(resolved.args).toEqual(["run", "lint:fix"]);
  expect(realpathProbe).not.toHaveBeenCalled();
  expect(lstatProbe).not.toHaveBeenCalled();
});

it("omits unprobed Fallow commands from missing-script diagnostics", async () => {
  const directory = await createNodeProject(scope, {
    packageManager: "npm@10.0.0",
    scripts: { lint: "node lint.js" },
  });
  await mkdir(join(directory, "node_modules", ".bin"), { recursive: true });
  await writeFile(join(directory, "node_modules", ".bin", "fallow"), "fallow");
  const definition = getProjectCommandDefinition("node_lint");
  if (definition === undefined) throw new Error("missing node_lint definition");

  await expect(
    resolveNodeProjectCommand(definition, directory, {
      commandId: "node_lint",
      variant: "fix",
    }),
  ).rejects.toMatchObject({
    stage: "probe",
    code: "inapplicable-command",
    details: {
      requiredPackageScript: "lint:fix",
      applicableCommands: ["node_project_info", "node_deps_list", "node_lint"],
    },
  });
});
