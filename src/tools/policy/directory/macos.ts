import { dirname, parse } from "node:path";

import {
  isMissingPolicyFileError,
  isPolicyFileAlreadyExistsError,
  type PolicyFileHandle,
  type PolicyFileStats,
  type PolicyFileSystem,
} from "../filesystem.ts";
import { policyError } from "../format.ts";
import type { OpenedPolicyDirectory, PolicyDirectoryOperations, SecureDirectory } from "./types.ts";

let policyCwdTail = Promise.resolve();

function samePolicyDirectory(left: PolicyFileStats, right: PolicyFileStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function acquireMacPolicyCwdLease(
  fileSystem: PolicyFileSystem,
  operations: PolicyDirectoryOperations,
): Promise<{ readonly close: () => Promise<void> }> {
  const predecessor = policyCwdTail;
  let releaseTail!: () => void;
  policyCwdTail = new Promise((resolve) => {
    releaseTail = resolve;
  });
  await predecessor;
  let originalHandle: PolicyFileHandle | undefined;
  let previous: string;
  let originalStats: PolicyFileStats;
  try {
    previous = process.cwd();
    const current = await operations.openDirectory(".", fileSystem);
    originalHandle = current.handle;
    originalStats = current.stats;
  } catch (error) {
    try {
      await operations.closeHandle(originalHandle);
    } catch {}
    releaseTail();
    throw error instanceof Error && error.message === policyError().message ? error : policyError();
  }
  let closed = false;
  return {
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      let closeError: Error | undefined;
      try {
        process.chdir(previous);
        const restored = await operations.openDirectory(".", fileSystem);
        try {
          if (!samePolicyDirectory(restored.stats, originalStats)) {
            throw policyError();
          }
        } finally {
          await operations.closeHandle(restored.handle);
        }
      } catch {
        closeError = policyError();
        try {
          process.chdir("/");
        } catch {
          closeError = policyError();
        }
      }
      try {
        await operations.closeHandle(originalHandle);
      } catch {
        closeError = policyError();
      } finally {
        releaseTail();
      }
      if (closeError !== undefined) {
        throw closeError;
      }
    },
  };
}

async function changeToOpenedMacPolicyDirectory(
  path: string,
  expected: PolicyFileStats,
  fileSystem: PolicyFileSystem,
  operations: PolicyDirectoryOperations,
): Promise<void> {
  process.chdir(path);
  const current = await operations.openDirectory(".", fileSystem);
  try {
    if (!samePolicyDirectory(current.stats, expected)) {
      throw policyError();
    }
  } finally {
    await operations.closeHandle(current.handle);
  }
}

async function openMacPolicyDirectoryComponents(
  components: readonly string[],
  index: number,
  handles: PolicyFileHandle[],
  fileSystem: PolicyFileSystem,
  createMissing: boolean,
  operations: PolicyDirectoryOperations,
): Promise<string> {
  const component = components[index];
  if (component === undefined) {
    return ".";
  }
  let next: OpenedPolicyDirectory;
  try {
    next = await operations.openDirectory(component, fileSystem);
  } catch (error) {
    if (!isMissingPolicyFileError(error) || !createMissing) {
      throw error;
    }
    try {
      await fileSystem.mkdir(component, { recursive: false, mode: 0o700 });
    } catch (mkdirError) {
      if (!isPolicyFileAlreadyExistsError(mkdirError)) {
        throw mkdirError;
      }
    }
    next = await operations.openDirectory(component, fileSystem);
  }
  await changeToOpenedMacPolicyDirectory(next.path, next.stats, fileSystem, operations);
  handles.push(next.handle);
  return openMacPolicyDirectoryComponents(
    components,
    index + 1,
    handles,
    fileSystem,
    createMissing,
    operations,
  );
}

export async function openMacPolicyParentDirectory(
  configPath: string,
  fileSystem: PolicyFileSystem,
  createMissing: boolean,
  operations: PolicyDirectoryOperations,
): Promise<SecureDirectory | undefined> {
  if (process.platform !== "darwin") {
    throw policyError();
  }
  const cwd = await acquireMacPolicyCwdLease(fileSystem, operations);
  const handles: PolicyFileHandle[] = [];
  try {
    const root = parse(configPath).root;
    const rootDirectory = await operations.openDirectory(root, fileSystem);
    handles.push(rootDirectory.handle);
    await changeToOpenedMacPolicyDirectory(
      rootDirectory.path,
      rootDirectory.stats,
      fileSystem,
      operations,
    );
    const components = dirname(configPath).slice(root.length).split("/").filter(Boolean);
    await openMacPolicyDirectoryComponents(
      components,
      0,
      handles,
      fileSystem,
      createMissing,
      operations,
    );
    return { path: ".", handles, closeCwd: cwd.close };
  } catch (error) {
    await operations.closeDirectory({ path: ".", handles, closeCwd: cwd.close });
    if (isMissingPolicyFileError(error) && !createMissing) {
      return undefined;
    }
    if (error instanceof Error && error.message === policyError().message) {
      throw error;
    }
    throw policyError();
  }
}
