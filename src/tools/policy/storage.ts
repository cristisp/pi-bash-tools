import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import {
  getPolicyReadOpenFlags,
  isMissingPolicyFileError,
  isPolicyFileAlreadyExistsError,
  isUnsupportedPolicyChmodError,
  type PolicyFileSystem,
} from "./filesystem.ts";
import {
  closePolicyHandle,
  closeSecureDirectory,
  openPolicyParentDirectory,
  type SecureDirectory,
} from "./directory/operations.ts";
import { createEmptyEnvironmentPolicy, policyError } from "./format.ts";
import { parsePolicyDocument, serializePolicyDocument } from "./document.ts";
import type { PolicyDocument } from "./types.ts";

const POLICY_LOCK_TIMEOUT_MS = 5_000;
const POLICY_LOCK_RETRY_MS = 25;

function throwIfPolicyOperationAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw policyError();
  }
}

async function readPolicyText(
  configPath: string,
  parent: SecureDirectory,
  fileSystem: PolicyFileSystem,
): Promise<string> {
  const policyPath = join(parent.path, basename(configPath));
  const handle = await fileSystem.open(policyPath, getPolicyReadOpenFlags());
  try {
    const stats = await handle.stat();
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw policyError();
    }
    return handle.readFile();
  } finally {
    await closePolicyHandle(handle);
  }
}

export async function readPolicyDocument(
  configPath: string,
  fileSystem: PolicyFileSystem,
  suppliedParent?: SecureDirectory,
): Promise<PolicyDocument> {
  const ownsParent = suppliedParent === undefined;
  const parent = suppliedParent ?? (await openPolicyParentDirectory(configPath, fileSystem, false));
  if (parent === undefined) {
    return { version: 1, environment: createEmptyEnvironmentPolicy() };
  }
  try {
    return parsePolicyDocument(await readPolicyText(configPath, parent, fileSystem));
  } catch (error) {
    if (isMissingPolicyFileError(error)) {
      return { version: 1, environment: createEmptyEnvironmentPolicy() };
    }
    if (error instanceof Error && error.message === policyError().message) {
      throw error;
    }
    throw policyError();
  } finally {
    if (ownsParent) {
      await closeSecureDirectory(parent);
    }
  }
}

async function validatePolicyDestination(
  path: string,
  fileSystem: PolicyFileSystem,
): Promise<void> {
  try {
    const stats = await fileSystem.lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw policyError();
    }
  } catch (error) {
    if (!isMissingPolicyFileError(error)) {
      throw error;
    }
  }
}

async function writePolicyTemporary(
  path: string,
  document: PolicyDocument,
  fileSystem: PolicyFileSystem,
): Promise<void> {
  await fileSystem.writeFile(path, serializePolicyDocument(document), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function restrictPolicyTemporary(path: string, fileSystem: PolicyFileSystem): Promise<void> {
  try {
    await fileSystem.chmod(path, 0o600);
  } catch (error) {
    if (!isUnsupportedPolicyChmodError(error)) {
      throw policyError();
    }
  }
}

export async function writePolicyDocumentAtomically(
  configPath: string,
  document: PolicyDocument,
  fileSystem: PolicyFileSystem,
  suppliedParent?: SecureDirectory,
  signal?: AbortSignal,
): Promise<void> {
  const temporaryName = `${basename(configPath)}.${process.pid}.${randomUUID()}.tmp`;
  const ownsParent = suppliedParent === undefined;
  const parent = suppliedParent ?? (await openPolicyParentDirectory(configPath, fileSystem, true));
  if (parent === undefined) {
    throw policyError();
  }
  const temporaryPath = join(parent.path, temporaryName);
  const destinationPath = join(parent.path, basename(configPath));
  let temporaryCreated = false;
  try {
    throwIfPolicyOperationAborted(signal);
    await validatePolicyDestination(destinationPath, fileSystem);
    throwIfPolicyOperationAborted(signal);
    await writePolicyTemporary(temporaryPath, document, fileSystem);
    temporaryCreated = true;
    await restrictPolicyTemporary(temporaryPath, fileSystem);
    throwIfPolicyOperationAborted(signal);
    await fileSystem.rename(temporaryPath, destinationPath);
    temporaryCreated = false;
  } catch (error) {
    if (temporaryCreated) {
      try {
        await fileSystem.unlink(temporaryPath);
      } catch {}
    }
    if (error instanceof Error && error.message === policyError().message) {
      throw error;
    }
    throw policyError();
  } finally {
    if (ownsParent) {
      await closeSecureDirectory(parent);
    }
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquirePolicyLockFile(
  lockPath: string,
  fileSystem: PolicyFileSystem,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  while (true) {
    try {
      throwIfPolicyOperationAborted(signal);
      await fileSystem.writeFile(lockPath, "", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return;
    } catch (error) {
      if (!isPolicyFileAlreadyExistsError(error) || Date.now() >= deadline) {
        throw policyError();
      }
      await sleep(Math.min(POLICY_LOCK_RETRY_MS, Math.max(1, deadline - Date.now())));
    }
  }
}

interface PolicyLock {
  readonly parent: SecureDirectory;
  readonly release: () => Promise<void>;
}

async function acquirePolicyLock(
  configPath: string,
  fileSystem: PolicyFileSystem,
  signal: AbortSignal | undefined,
): Promise<PolicyLock> {
  const parent = await openPolicyParentDirectory(configPath, fileSystem, true);
  if (parent === undefined) {
    throw policyError();
  }
  const lockPath = join(parent.path, `${basename(configPath)}.lock`);
  const deadline = Date.now() + POLICY_LOCK_TIMEOUT_MS;
  try {
    await acquirePolicyLockFile(lockPath, fileSystem, deadline, signal);
    let released = false;
    return {
      parent,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        try {
          await fileSystem.unlink(lockPath);
        } catch (error) {
          if (!isMissingPolicyFileError(error)) {
            throw policyError();
          }
        } finally {
          await closeSecureDirectory(parent);
        }
      },
    };
  } catch (error) {
    await closeSecureDirectory(parent);
    throw error instanceof Error && error.message === policyError().message ? error : policyError();
  }
}

export async function withPolicyLock<T>(
  configPath: string,
  fileSystem: PolicyFileSystem,
  signal: AbortSignal | undefined,
  operation: (parent: SecureDirectory) => Promise<T>,
): Promise<T> {
  const lock = await acquirePolicyLock(configPath, fileSystem, signal);
  try {
    throwIfPolicyOperationAborted(signal);
    return await operation(lock.parent);
  } finally {
    await lock.release();
  }
}
