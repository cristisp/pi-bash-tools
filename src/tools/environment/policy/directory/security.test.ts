import { execFile as execFileCallback } from "node:child_process";
import { mkdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEnvironmentPolicyStoreForTesting } from "../../policy.ts";
import { createPolicyTestFixtures } from "../test-fixtures.ts";

const fixtures = createPolicyTestFixtures();
const execFile = promisify(execFileCallback);

afterEach(() => fixtures.cleanup());

describe("environment policy directory security", () => {
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
    const store = createEnvironmentPolicyStoreForTesting({
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
      await expect(store.recordDecision(root, "CWD", "allow-project")).rejects.toThrow(
        /invalid or unreadable/iu,
      );
      expect(swapped).toBe(true);
      expect(process.cwd()).toBe("/");
      const loaded = await store.load(root);
      expect(loaded.projects[root]?.allow).toEqual(["CWD"]);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("releases a pending cwd lease when cwd capture fails", async () => {
    const directory = await fixtures.createDirectory();
    const configPath = join(await realpath(directory), "bash-tools.json");
    const projectPath = await realpath(directory);
    const store = createEnvironmentPolicyStoreForTesting({ configPath });
    const cwd = vi.spyOn(process, "cwd");
    cwd.mockImplementationOnce(() => {
      throw new Error("cwd unavailable");
    });
    await expect(store.recordDecision(projectPath, "FIRST", "allow-project")).rejects.toThrow(
      /invalid or unreadable/iu,
    );
    cwd.mockRestore();
    await store.recordDecision(projectPath, "SECOND", "allow-project");
    expect((await store.load(projectPath)).projects[projectPath]?.allow).toEqual(["SECOND"]);
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
    for (const configPath of unsafePaths) {
      const store = createEnvironmentPolicyStoreForTesting({ configPath });
      // eslint-disable-next-line no-await-in-loop
      await expect(store.load(projectPath)).rejects.toThrow(/invalid or unreadable/iu);
    }

    const fifoPath = join(directory, "fifo");
    await execFile("mkfifo", [fifoPath]);
    const store = createEnvironmentPolicyStoreForTesting({ configPath: fifoPath });
    await expect(store.load(projectPath)).rejects.toThrow(/invalid or unreadable/iu);
  });
});
