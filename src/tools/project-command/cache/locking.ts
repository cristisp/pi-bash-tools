import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const CACHE_LOCK_TIMEOUT_MS = 30_000;
const CACHE_LOCK_RETRY_MS = 10;
const CACHE_LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

export function removeFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (!isMissing(error)) return;
  }
}

export interface CacheLockHandle {
  readonly path: string;
  readonly token: string;
  readonly ownerPath: string;
}

function newLockToken(): string {
  return `${process.pid}:${randomBytes(16).toString("hex")}`;
}

function removeLockPath(lockPath: string): void {
  try {
    rmSync(lockPath, { force: true, recursive: true });
  } catch {
    return;
  }
}

function ownerPathIn(lockPath: string): string | undefined {
  try {
    const ownerNames = readdirSync(lockPath).filter(
      (name) => name.startsWith("owner-") && name.endsWith(".token"),
    );
    return ownerNames.length === 1 ? join(lockPath, ownerNames[0]) : undefined;
  } catch {
    return undefined;
  }
}

function createLock(lockPath: string, token: string): CacheLockHandle | undefined {
  const temporaryPath = `${lockPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const ownerName = `owner-${randomBytes(16).toString("hex")}.token`;
  try {
    mkdirSync(temporaryPath, { mode: 0o700 });
    writeFileSync(join(temporaryPath, ownerName), token, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, lockPath);
    return { path: lockPath, token, ownerPath: join(lockPath, ownerName) };
  } catch {
    removeLockPath(temporaryPath);
    return undefined;
  }
}

function reclaimStaleDirectoryLock(
  lockPath: string,
  now: number,
  beforeStaleOwnerRemoval?: (lockPath: string, ownerPath: string) => void,
): boolean {
  const ownerPath = ownerPathIn(lockPath);
  if (ownerPath === undefined) return false;
  try {
    if (now - statSync(ownerPath).mtimeMs <= CACHE_LOCK_TIMEOUT_MS) return false;
    beforeStaleOwnerRemoval?.(lockPath, ownerPath);
    unlinkSync(ownerPath);
  } catch {
    return false;
  }
  try {
    rmdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function reclaimStaleLegacyLock(
  lockPath: string,
  now: number,
  beforeStaleOwnerRemoval?: (lockPath: string, ownerPath: string) => void,
): CacheLockHandle | undefined {
  const operationPath = `${lockPath}.operation`;
  const operationLock = acquireLock(operationPath, now, beforeStaleOwnerRemoval);
  if (operationLock === undefined) return undefined;
  try {
    const lockStats = statSync(lockPath);
    if (lockStats.isDirectory() || now - lockStats.mtimeMs <= CACHE_LOCK_TIMEOUT_MS)
      return undefined;
    beforeStaleOwnerRemoval?.(lockPath, lockPath);
    const currentStats = statSync(lockPath);
    if (
      currentStats.isDirectory() ||
      currentStats.dev !== lockStats.dev ||
      currentStats.ino !== lockStats.ino
    ) {
      return undefined;
    }
    const quarantinePath = `${lockPath}.${randomBytes(8).toString("hex")}.stale`;
    renameSync(lockPath, quarantinePath);
    removeLockPath(quarantinePath);
    return createLock(lockPath, newLockToken());
  } catch {
    return undefined;
  } finally {
    releaseOwnedLock(operationLock);
  }
}

export function acquireLock(
  lockPath: string,
  now: number,
  beforeStaleOwnerRemoval?: (lockPath: string, ownerPath: string) => void,
): CacheLockHandle | undefined {
  const created = createLock(lockPath, newLockToken());
  if (created !== undefined) return created;
  try {
    if (statSync(lockPath).isDirectory()) {
      if (!reclaimStaleDirectoryLock(lockPath, now, beforeStaleOwnerRemoval)) return undefined;
      return createLock(lockPath, newLockToken());
    }
  } catch {
    return reclaimStaleLegacyLock(lockPath, now, beforeStaleOwnerRemoval);
  }
  return reclaimStaleLegacyLock(lockPath, now, beforeStaleOwnerRemoval);
}

export function releaseOwnedLock(handle: CacheLockHandle): void {
  let ownsToken = false;
  try {
    if (readFileSync(handle.ownerPath, "utf8") === handle.token) {
      unlinkSync(handle.ownerPath);
      ownsToken = true;
    }
  } catch {
    ownsToken = false;
  }
  if (!ownsToken) return;
  try {
    rmdirSync(handle.path);
  } catch {
    return;
  }
}

export function acquireGlobalMutationLock(
  rootDirectory: string,
  beforeStaleOwnerRemoval?: (lockPath: string, ownerPath: string) => void,
): CacheLockHandle | undefined {
  try {
    mkdirSync(rootDirectory, { recursive: true });
  } catch {
    return undefined;
  }
  const lockPath = join(rootDirectory, "flows.lock");
  const deadline = Date.now() + CACHE_LOCK_TIMEOUT_MS;
  while (true) {
    const lock = acquireLock(lockPath, Date.now(), beforeStaleOwnerRemoval);
    if (lock !== undefined) return lock;
    if (Date.now() >= deadline) return undefined;
    Atomics.wait(CACHE_LOCK_WAIT_BUFFER, 0, 0, CACHE_LOCK_RETRY_MS);
  }
}

export function evictDirectory(
  directory: string,
  now: number,
  maxAgeMs: number,
  maxBytes: number,
): void {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  const files: Array<{ readonly path: string; readonly size: number; readonly modified: number }> =
    [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(directory, name);
    try {
      const stats = statSync(path);
      if (now - stats.mtimeMs > maxAgeMs) {
        removeFile(path);
        continue;
      }
      files.push({ path, size: stats.size, modified: stats.mtimeMs });
    } catch {
      continue;
    }
  }
  let total = files.reduce((sum, file) => sum + file.size, 0);
  if (total <= maxBytes) return;
  files.sort((left, right) => left.modified - right.modified);
  for (const file of files) {
    if (total <= maxBytes) break;
    removeFile(file.path);
    total -= file.size;
  }
}
