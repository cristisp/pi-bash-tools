import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
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
      applicableCommands: ["node_project_info", "node_deps_list"],
    });

    const escapingProject = await project({ scripts: {} });
    const outside = await project({ scripts: {} });
    await writeFile(join(outside, "fallow"), "escaping");
    await mkdir(join(escapingProject, "node_modules", ".bin"), { recursive: true });
    await symlink(join(outside, "fallow"), join(escapingProject, "node_modules", ".bin", "fallow"));
    await expect(readNodeProjectInfo(escapingProject)).resolves.toMatchObject({
      applicableCommands: ["node_project_info", "node_deps_list"],
    });

    const danglingProject = await project({ scripts: {} });
    await mkdir(join(danglingProject, "node_modules", ".bin"), { recursive: true });
    await symlink(
      join(danglingProject, "missing-fallow"),
      join(danglingProject, "node_modules", ".bin", "fallow"),
    );
    await expect(readNodeProjectInfo(danglingProject)).resolves.toMatchObject({
      applicableCommands: ["node_project_info", "node_deps_list"],
    });

    const nonFileProject = await project({ scripts: {} });
    await mkdir(join(nonFileProject, "node_modules", ".bin", "fallow"), { recursive: true });
    await expect(readNodeProjectInfo(nonFileProject)).resolves.toMatchObject({
      applicableCommands: ["node_project_info", "node_deps_list"],
    });

    const validProject = await project({ scripts: {} });
    await mkdir(join(validProject, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(validProject, "node_modules", ".bin", "fallow"), "fallow");
    await expect(readNodeProjectInfo(validProject)).resolves.toMatchObject({
      applicableCommands: ["node_project_info", "node_deps_list", ...fallowCommandIds],
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

  it("reports and resolves only the exact formatting scripts", async () => {
    const directory = await project({
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

  it("does not report formatting commands for similarly named scripts", async () => {
    const directory = await project({
      packageManager: "npm@10.0.0",
      scripts: { "format:checker": "node check-format.js", formatter: "node format.js" },
    });
    await expect(readNodeProjectInfo(directory)).resolves.toMatchObject({
      scripts: ["format:checker", "formatter"],
      applicableCommands: ["node_project_info", "node_deps_list"],
    });
  });

  it("reports the required script and fixed manager command for every missing Node script", async () => {
    const directory = await project({
      packageManager: "npm@10.0.0",
      scripts: {
        zed: "node zed.js",
        build: "node build.js",
        "format:checker": "node check-format.js",
      },
    });
    const info = await readNodeProjectInfo(directory);
    const cases = [
      { commandId: "node_format_check", script: "format:check" },
      { commandId: "node_format_write", script: "format" },
      { commandId: "node_test", script: "test" },
    ] as const;

    await Promise.all(
      cases.map(async ({ commandId, script }) => {
        const definition = getProjectCommandDefinition(commandId);
        if (definition === undefined) throw new Error(`missing ${commandId} definition`);
        await expect(
          resolveNodeProjectCommand(definition, directory, { commandId }),
        ).rejects.toMatchObject({
          name: "ProjectCommandResolutionError",
          stage: "probe",
          code: "inapplicable-command",
          details: {
            commandId,
            requiredPackageScript: script,
            packageManagerCommand: `npm run ${script}`,
            availableScripts: ["build", "format:checker", "zed"],
            applicableCommands: info.applicableCommands,
          },
        });
      }),
    );
  });

  it("resolves each supported dependency-list form without requiring node_modules", async () => {
    const cases = [
      { manager: "npm", version: "10.0.0", args: ["ls", "--depth=0"] },
      { manager: "pnpm", version: "9.0.0", args: ["list", "--depth=0"] },
      { manager: "bun", version: "1.0.0", args: ["pm", "ls"] },
      { manager: "yarn", version: "1.22.22", args: ["list", "--depth=0"] },
    ] as const;
    await Promise.all(
      cases.map(async (entry) => {
        const directory = await project({ packageManager: `${entry.manager}@${entry.version}` });
        const toolchain = join(directory, "toolchain");
        await mkdir(toolchain);
        const executable = join(toolchain, entry.manager);
        await writeFile(executable, "manager");
        await chmod(executable, 0o755);
        const definition = getProjectCommandDefinition("node_deps_list");
        if (definition === undefined) throw new Error("missing node_deps_list definition");
        const resolved = await resolveNodeProjectCommand(
          definition,
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
    const directory = await project({ packageManager: "yarn@4.2.0" });
    const toolchain = join(directory, "toolchain");
    await mkdir(toolchain);
    const executable = join(toolchain, "yarn");
    await writeFile(executable, "yarn");
    await chmod(executable, 0o755);
    const options = {
      nodeExecutable: join(toolchain, "node"),
      approvedPackageManagerDirectories: [],
    };
    const definition = getProjectCommandDefinition("node_deps_list");
    if (definition === undefined) throw new Error("missing node_deps_list definition");
    await expect(
      resolveNodeProjectCommand(definition, directory, { commandId: "node_deps_list" }, options),
    ).rejects.toMatchObject({
      stage: "detection",
      code: "unsupported-yarn-version",
    });
    await expect(readNodeProjectInfo(directory, options)).resolves.toMatchObject({
      packageManager: { manager: "yarn", version: "4.2.0", executableAvailable: true },
      applicableCommands: ["node_project_info"],
    });
  });

  it("keeps an unavailable manager distinct from dependency-list command results", async () => {
    const directory = await project({ packageManager: "pnpm@9.0.0" });
    const definition = getProjectCommandDefinition("node_deps_list");
    if (definition === undefined) throw new Error("missing node_deps_list definition");
    await expect(
      resolveNodeProjectCommand(
        definition,
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
