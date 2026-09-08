import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getProjectCommandDefinition,
  projectCommandIdentity,
} from "../../../src/tools/project-command/definitions.ts";
import { resolveProjectCommand } from "../../../src/tools/project-command/resolution.ts";
import { createBinaryProject, createResolutionTestScope } from "./test-fixtures.ts";

const scope = createResolutionTestScope();

afterEach(scope.cleanup);

describe("Fallow project binary resolution", () => {
  it("resolves Fallow through the project-local binary and process.execPath", async () => {
    const { directory, nodeModules, binDirectory } = await createBinaryProject(scope);
    const fallowTarget = join(nodeModules, "fallow", "bin", "fallow");
    await mkdir(join(nodeModules, "fallow", "bin"), { recursive: true });
    await writeFile(fallowTarget, "#!/usr/bin/env node\\n");
    await symlink("../fallow/bin/fallow", join(binDirectory, "fallow"));
    const definition = getProjectCommandDefinition("fallow_health");
    const auditDefinition = getProjectCommandDefinition("fallow_audit");
    if (definition === undefined || auditDefinition === undefined) {
      throw new Error("missing Fallow definition");
    }

    const resolved = await resolveProjectCommand(definition, directory, undefined);
    expect(resolved.executable).toBe(process.execPath);
    expect(resolved.args).toEqual([
      await realpath(fallowTarget),
      "health",
      "--format",
      "json",
      "--quiet",
    ]);
    expect(resolved.displayCommand).toContain(
      `${process.execPath} ${await realpath(fallowTarget)}`,
    );

    const audit = await resolveProjectCommand(auditDefinition, directory, undefined, {
      commandId: "fallow_audit",
      base: "HEAD~1",
    });
    const changedBase = await resolveProjectCommand(auditDefinition, directory, undefined, {
      commandId: "fallow_audit",
      base: "origin/main",
    });
    expect(audit.args).toEqual([
      await realpath(fallowTarget),
      "audit",
      "--format",
      "json",
      "--quiet",
      "--base",
      "HEAD~1",
    ]);
    expect(audit.effectiveParameters).toEqual({ base: "HEAD~1" });
    expect(projectCommandIdentity(auditDefinition, audit)).toEqual(
      projectCommandIdentity(auditDefinition, changedBase),
    );
  });
});
