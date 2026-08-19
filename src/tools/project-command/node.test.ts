import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
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
