import { execFile as execFileCallback } from "node:child_process";
import { mkdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createPolicyStoreForTesting } from "../../../src/tools/policy/store.ts";
import { createPolicyTestFixtures } from "../test-fixtures.ts";

const fixtures = createPolicyTestFixtures();
const execFile = promisify(execFileCallback);

afterEach(() => fixtures.cleanup());

it("restores a safe cwd and releases the lease when the original cwd is replaced", async () => {
  const directory = await fixtures.createDirectory();
  const root = await realpath(directory);
  const originalCwd = process.cwd();
  const workingDirectory = join(root, "working");
  const movedWorkingDirectory = join(root, "moved-working");
  const targetDirectory = join(root, "target");
  const policyDirectory = join(root, "policy");
  await mkdir(workingDirectory);
  await mkdir(targetDirectory);
  await mkdir(policyDirectory);
  const configPath = join(policyDirectory, "bash-tools.json");
  let swapped = false;
  const store = createPolicyStoreForTesting({
    configPath,
    fs: {
      writeFile: async (path, data, options) => {
        if (path.endsWith(".lock") && !swapped) {
          swapped = true;
          await rename(workingDirectory, movedWorkingDirectory);
          await symlink(targetDirectory, workingDirectory);
        }
        await writeFile(path, data, options);
      },
    },
  });
  try {
    process.chdir(workingDirectory);
    await expect(
      store.recordDecisions(root, [{ kind: "environment", key: "CWD", decision: "allow-project" }]),
    ).rejects.toThrow(/invalid or unreadable/iu);
    expect(swapped).toBe(true);
    expect(process.cwd()).toBe("/");
    const loaded = await store.load(root);
    expect(loaded.document.environment.projects[root]?.allow).toEqual(["CWD"]);
  } finally {
    process.chdir(originalCwd);
  }
});

it("releases a pending cwd lease when cwd capture fails", async () => {
  const directory = await fixtures.createDirectory();
  const configPath = join(await realpath(directory), "bash-tools.json");
  const projectPath = await realpath(directory);
  const store = createPolicyStoreForTesting({ configPath });
  const cwd = vi.spyOn(process, "cwd");
  cwd.mockImplementationOnce(() => {
    throw new Error("cwd unavailable");
  });
  await expect(
    store.recordDecisions(projectPath, [
      { kind: "environment", key: "FIRST", decision: "allow-project" },
    ]),
  ).rejects.toThrow(/invalid or unreadable/iu);
  cwd.mockRestore();
  await store.recordDecisions(projectPath, [
    { kind: "environment", key: "SECOND", decision: "allow-project" },
  ]);
  expect((await store.load(projectPath)).document.environment.projects[projectPath]?.allow).toEqual(
    ["SECOND"],
  );
});

it("rejects symlink, dangling, directory, FIFO, and unsafe-parent policy paths", async () => {
  const directory = await fixtures.createDirectory();
  const projectPath = await realpath(directory);
  const target = join(directory, "target.json");
  await writeFile(target, '{"version":1}');

  const symlinkPath = join(directory, "symlink.json");
  const danglingPath = join(directory, "dangling.json");
  const directoryPath = join(directory, "directory.json");
  await symlink(target, symlinkPath);
  await symlink(join(directory, "missing.json"), danglingPath);
  await mkdir(directoryPath);

  const unsafeParentTarget = join(directory, "unsafe-target");
  const unsafeParentLink = join(directory, "unsafe-parent");
  const unsafeParentFile = join(directory, "unsafe-parent-file");
  await mkdir(unsafeParentTarget);
  await symlink(unsafeParentTarget, unsafeParentLink);
  await writeFile(unsafeParentFile, "not a directory");

  const unsafePaths = [
    symlinkPath,
    danglingPath,
    directoryPath,
    join(unsafeParentLink, "bash-tools.json"),
    join(unsafeParentFile, "bash-tools.json"),
  ];
  await Promise.all(
    unsafePaths.map(async (configPath) => {
      const store = createPolicyStoreForTesting({ configPath });
      await expect(store.load(projectPath)).rejects.toThrow(/invalid or unreadable/iu);
    }),
  );

  const fifoPath = join(directory, "fifo");
  await execFile("mkfifo", [fifoPath]);
  const store = createPolicyStoreForTesting({ configPath: fifoPath });
  await expect(store.load(projectPath)).rejects.toThrow(/invalid or unreadable/iu);
});
