import {
  getPolicyDirectoryOpenFlags,
  isMissingPolicyFileError,
  type PolicyFileHandle,
  type PolicyFileSystem,
} from "../filesystem.ts";
import { policyError, validatePolicyPath } from "../format.ts";
import type { OpenedPolicyDirectory, PolicyDirectoryOperations, SecureDirectory } from "./types.ts";

export type { SecureDirectory } from "./types.ts";

export async function closePolicyHandle(handle: PolicyFileHandle | undefined): Promise<void> {
  if (handle === undefined) {
    return;
  }
  try {
    await handle.close();
  } catch {
    throw policyError();
  }
}

export async function closeSecureDirectory(directory: SecureDirectory): Promise<void> {
  let closeError: Error | undefined;
  try {
    await Promise.all(directory.handles.map((handle) => closePolicyHandle(handle)));
  } catch {
    closeError = policyError();
  }
  try {
    await directory.closeCwd?.();
  } catch {
    closeError = policyError();
  }
  if (closeError !== undefined) {
    throw closeError;
  }
}

async function openPolicyDirectory(
  path: string,
  fileSystem: PolicyFileSystem,
): Promise<OpenedPolicyDirectory> {
  let handle: PolicyFileHandle | undefined;
  try {
    handle = await fileSystem.open(path, getPolicyDirectoryOpenFlags());
    const stats = await handle.stat();
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw policyError();
    }
    return { path, handle, stats };
  } catch (error) {
    await closePolicyHandle(handle);
    if (isMissingPolicyFileError(error)) {
      throw error;
    }
    if (error instanceof Error && error.message === policyError().message) {
      throw error;
    }
    throw policyError();
  }
}

const policyDirectoryOperations: PolicyDirectoryOperations = {
  closeHandle: closePolicyHandle,
  closeDirectory: closeSecureDirectory,
  openDirectory: openPolicyDirectory,
};

export async function openPolicyParentDirectory(
  configPath: string,
  fileSystem: PolicyFileSystem,
  createMissing: boolean,
): Promise<SecureDirectory | undefined> {
  validatePolicyPath(configPath);
  if (process.platform === "darwin") {
    const { openMacPolicyParentDirectory } = await import("./macos.ts");
    return openMacPolicyParentDirectory(
      configPath,
      fileSystem,
      createMissing,
      policyDirectoryOperations,
    );
  }
  if (process.platform === "linux") {
    const { openLinuxPolicyParentDirectory } = await import("./linux.ts");
    return openLinuxPolicyParentDirectory(
      configPath,
      fileSystem,
      createMissing,
      policyDirectoryOperations,
    );
  }
  throw policyError();
}
