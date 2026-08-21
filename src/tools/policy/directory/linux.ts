import { dirname, join, parse } from "node:path";
import type { OpenedPolicyDirectory, PolicyDirectoryOperations, SecureDirectory } from "./types.ts";
import {
  isMissingPolicyFileError,
  isPolicyFileAlreadyExistsError,
  type PolicyFileHandle,
  type PolicyFileSystem,
} from "../filesystem.ts";
import { policyError } from "../format.ts";

function policyDescriptorPath(fd: number): string {
  if (process.platform !== "linux" || !Number.isInteger(fd) || fd < 0) {
    throw policyError();
  }
  return `/proc/self/fd/${fd}`;
}

async function openLinuxPolicyDirectory(
  path: string,
  fileSystem: PolicyFileSystem,
  operations: PolicyDirectoryOperations,
): Promise<OpenedPolicyDirectory> {
  const opened = await operations.openDirectory(path, fileSystem);
  return { ...opened, path: policyDescriptorPath(opened.handle.fd) };
}

async function openLinuxPolicyDirectoryComponents(
  current: OpenedPolicyDirectory,
  components: readonly string[],
  index: number,
  handles: PolicyFileHandle[],
  fileSystem: PolicyFileSystem,
  createMissing: boolean,
  operations: PolicyDirectoryOperations,
): Promise<string> {
  const component = components[index];
  if (component === undefined) {
    return current.path;
  }
  const childPath = join(current.path, component);
  let next: OpenedPolicyDirectory;
  try {
    next = await openLinuxPolicyDirectory(childPath, fileSystem, operations);
  } catch (error) {
    if (!isMissingPolicyFileError(error) || !createMissing) {
      throw error;
    }
    try {
      await fileSystem.mkdir(childPath, { recursive: false, mode: 0o700 });
    } catch (mkdirError) {
      if (!isPolicyFileAlreadyExistsError(mkdirError)) {
        throw mkdirError;
      }
    }
    next = await openLinuxPolicyDirectory(childPath, fileSystem, operations);
  }
  handles.push(next.handle);
  return openLinuxPolicyDirectoryComponents(
    next,
    components,
    index + 1,
    handles,
    fileSystem,
    createMissing,
    operations,
  );
}

export async function openLinuxPolicyParentDirectory(
  configPath: string,
  fileSystem: PolicyFileSystem,
  createMissing: boolean,
  operations: PolicyDirectoryOperations,
): Promise<SecureDirectory | undefined> {
  if (process.platform !== "linux") {
    throw policyError();
  }
  const root = parse(configPath).root;
  const parent = dirname(configPath);
  const components = parent.slice(root.length).split("/").filter(Boolean);
  const handles: PolicyFileHandle[] = [];
  try {
    const rootDirectory = await openLinuxPolicyDirectory(root, fileSystem, operations);
    handles.push(rootDirectory.handle);
    const path = await openLinuxPolicyDirectoryComponents(
      rootDirectory,
      components,
      0,
      handles,
      fileSystem,
      createMissing,
      operations,
    );
    return { path, handles };
  } catch (error) {
    try {
      await operations.closeDirectory({ path: "", handles });
    } catch {}
    if (isMissingPolicyFileError(error) && !createMissing) {
      return undefined;
    }
    if (error instanceof Error && error.message === policyError().message) {
      throw error;
    }
    throw policyError();
  }
}
