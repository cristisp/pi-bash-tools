import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalizeNodeScripts,
  hashNodeScripts,
  readNodeProjectInfo,
  resolveNodeProjectCommand,
} from "./node.ts";
import { getProjectCommandDefinition, projectCommandIdentity } from "./definitions.ts";
import { findPackageManagerExecutable } from "./resolution.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function project(manifest: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bash-tools-node-"));
  directories.push(directory);
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
  return await realpath(directory);
}

describe("Node project command resolution", () => {
  it("reports a missing manifest without defaulting to npm", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bash-tools-node-missing-"));
    directories.push(directory);
    await expect(readNodeProjectInfo(directory)).resolves.toMatchObject({
      nodeVersion: process.version,
      manifestPresent: false,
      packageManager: null,
      scripts: [],
      applicableCommands: ["node_project_info"],
    });
  });

  it("reports Fallow commands when the project-local binary is available", async () => {
    const directory = await project({ scripts: {} });
    await mkdir(join(directory, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(directory, "node_modules", ".bin", "fallow"), "fallow");
    await expect(readNodeProjectInfo(directory)).resolves.toMatchObject({
      applicableCommands: [
        "node_project_info",
        "fallow_dead_code",
        "fallow_dupes",
        "fallow_health",
        "fallow_audit",
        "fallow_list_entry_points",
        "fallow_list_boundaries",
      ],
    });
  });

  it("reports Fallow only for a safe in-root binary", async () => {
    const fallowCommandIds = [
      "fallow_dead_code",
      "fallow_dupes",
      "fallow_health",
      "fallow_audit",
      "fallow_list_entry_points",
      "fallow_list_boundaries",
    ];
    const missingProject = await project({ scripts: {} });
    await expect(readNodeProjectInfo(missingProject)).resolves.toMatchObject({
      applicableCommands: ["node_project_info"],
    });

    const escapingProject = await project({ scripts: {} });
    const outside = await project({ scripts: {} });
    await writeFile(join(outside, "fallow"), "escaping");
    await mkdir(join(escapingProject, "node_modules", ".bin"), { recursive: true });
    await symlink(join(outside, "fallow"), join(escapingProject, "node_modules", ".bin", "fallow"));
    await expect(readNodeProjectInfo(escapingProject)).resolves.toMatchObject({
      applicableCommands: ["node_project_info"],
    });

    const danglingProject = await project({ scripts: {} });
    await mkdir(join(danglingProject, "node_modules", ".bin"), { recursive: true });
    await symlink(
      join(danglingProject, "missing-fallow"),
      join(danglingProject, "node_modules", ".bin", "fallow"),
    );
    await expect(readNodeProjectInfo(danglingProject)).resolves.toMatchObject({
      applicableCommands: ["node_project_info"],
    });

    const nonFileProject = await project({ scripts: {} });
    await mkdir(join(nonFileProject, "node_modules", ".bin", "fallow"), { recursive: true });
    await expect(readNodeProjectInfo(nonFileProject)).resolves.toMatchObject({
      applicableCommands: ["node_project_info"],
    });

    const validProject = await project({ scripts: {} });
    await mkdir(join(validProject, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(validProject, "node_modules", ".bin", "fallow"), "fallow");
    await expect(readNodeProjectInfo(validProject)).resolves.toMatchObject({
      applicableCommands: ["node_project_info", ...fallowCommandIds],
    });
  });

  it("reports exact scripts and resolves fixed manager-mediated argv", async () => {
    const directory = await project({
      packageManager: "npm@10.0.0",
      scripts: { test: "node runner.js", build: "node build.js" },
    });
    await writeFile(join(directory, "runner.js"), "runner");
    const definition = getProjectCommandDefinition("node_test");
    if (definition === undefined) throw new Error("missing node_test definition");
    const resolved = await resolveNodeProjectCommand(definition, directory, {
      commandId: "node_test",
      paths: ["runner.js"],
    });
    expect(resolved.args).toEqual(["run", "test", "--", "runner.js"]);
    expect(resolved.script).toBe("node runner.js");
    expect(resolved.executable.startsWith("/")).toBe(true);
    const withoutPath = await resolveNodeProjectCommand(definition, directory, {
      commandId: "node_test",
    });
    expect(projectCommandIdentity(definition, resolved)).toEqual(
      projectCommandIdentity(definition, withoutPath),
    );
    const changed = await project({
      packageManager: "npm@10.0.0",
      scripts: { test: "node changed.js" },
    });
    const changedResolved = await resolveNodeProjectCommand(definition, changed, {
      commandId: "node_test",
    });
    expect(projectCommandIdentity(definition, changedResolved)).not.toEqual(
      projectCommandIdentity(definition, withoutPath),
    );
  });

  it("canonicalizes script key order while retaining script string identity", () => {
    expect(canonicalizeNodeScripts({ z: "z", a: "a" })).toBe('{"a":"a","z":"z"}');
    expect(hashNodeScripts({ a: "same", z: "same" })).toBe(
      hashNodeScripts({ z: "same", a: "same" }),
    );
    expect(hashNodeScripts({ a: "same" })).not.toBe(hashNodeScripts({ a: "changed" }));
  });

  it("only checks fixed absolute manager candidates", async () => {
    const checked: string[] = [];
    const executableStats = await stat(process.execPath);
    const directoryStats = await stat(tmpdir());
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
