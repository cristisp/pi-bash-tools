import { createHash, randomBytes } from "node:crypto";
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
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProjectCommandOutputDetails } from "./output.ts";
import type { ProjectCommandStateSnapshot } from "./state-snapshot.ts";
import { readProjectCommandOrchestrationContext } from "./orchestration.ts";

export type ProjectCommandCacheDecision = "miss" | "hit" | "forced" | "ineligible" | "invalidated";

export interface ProjectCommandCacheProvenance {
  readonly producerSessionId: string;
  readonly producerRole?: string;
  readonly flowId: string;
  readonly repositoryIdentity: string;
  readonly workingDirectory: string;
  readonly head: string;
  readonly dirtyFilesDigest: string;
  readonly snapshotDigest: string;
  readonly writeTimestamp: number;
}

export interface ProjectCommandResultCacheEntry {
  readonly logicalRequestKey: string;
  readonly resultFingerprint: string;
  readonly details: ProjectCommandOutputDetails;
  readonly snapshot: ProjectCommandStateSnapshot;
  readonly producerInvocationId: string;
  readonly provenance?: ProjectCommandCacheProvenance;
}

export interface ProjectCommandResultCache {
  get(sessionId: string, logicalRequestKey: string): ProjectCommandResultCacheEntry | undefined;
  set(sessionId: string, entry: ProjectCommandResultCacheEntry): void;
  delete(sessionId: string, logicalRequestKey: string): void;
  clear(): void;
}

export type ProjectCommandDiskCacheMutationLock = (operation: () => void) => void;

export interface ProjectCommandDiskCacheClaim {
  readonly claimId: symbol;
}

export type ProjectCommandDiskCacheRecordValidator = (
  value: unknown,
  logicalRequestKey?: string,
  scopeKey?: string,
) => boolean;

export interface ProjectCommandDiskJsonCache {
  get(scopeKey: string, logicalRequestKey: string): unknown;
  set(scopeKey: string, logicalRequestKey: string, record: unknown): void;
  delete(scopeKey: string, logicalRequestKey: string): void;
  clear(): void;
  tryClaim(scopeKey: string, logicalRequestKey: string): ProjectCommandDiskCacheClaim | undefined;
  releaseClaim(claim: ProjectCommandDiskCacheClaim): void;
}

export interface ProjectCommandDiskResultCacheOptions {
  readonly rootDirectory?: string;
  readonly scopeKey?: string;
  readonly maxAgeMs?: number;
  readonly maxBytes?: number;
  readonly now?: () => number;
  readonly mutationLock?: ProjectCommandDiskCacheMutationLock;
  readonly beforeRename?: (temporaryPath: string, targetPath: string) => void;
  readonly beforeStaleOwnerRemoval?: (lockPath: string, ownerPath: string) => void;
}

const DEFAULT_CACHE_ROOT = join(homedir(), ".pi", "agent", "bash-tools");
const DEFAULT_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_CACHE_MAX_BYTES = 50 * 1024 * 1024;
const CACHE_ENTRY_FORMAT_VERSION = 1 as const;
const CACHE_ENTRY_MAX_BYTES = 2 * 1024 * 1024;
const CACHE_LOCK_TIMEOUT_MS = 30_000;
const CACHE_LOCK_RETRY_MS = 10;
const CACHE_SCOPE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const CACHE_LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const CACHE_FIELD_MAX_LENGTH = 8 * 1024;
const CACHE_ARRAY_MAX_ITEMS = 4_096;
const CACHE_TOTAL_BYTES_MAX = 256 * 1024 * 1024;
const CACHE_TOTAL_LINES_MAX = 4_000_000;
const CACHE_DURATION_MAX_MS = 24 * 60 * 60 * 1_000;

type DiskCacheRecord = ProjectCommandResultCacheEntry & {
  readonly cacheFormatVersion: typeof CACHE_ENTRY_FORMAT_VERSION;
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength = CACHE_FIELD_MAX_LENGTH): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isStateSnapshot(value: unknown): value is ProjectCommandStateSnapshot {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > CACHE_ARRAY_MAX_ITEMS
  ) {
    return false;
  }
  return value.entries.every(
    (entry) => isRecord(entry) && isBoundedString(entry.path) && isBoundedString(entry.type, 128),
  );
}

function isBoundedNonNegativeInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function isBoundedDuration(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= CACHE_DURATION_MAX_MS
  );
}

function isOutputStream(value: unknown): boolean {
  return (
    isRecord(value) &&
    isBoundedString(value.text, CACHE_ENTRY_MAX_BYTES) &&
    typeof value.truncated === "boolean" &&
    isBoundedNonNegativeInteger(value.totalBytes, CACHE_TOTAL_BYTES_MAX) &&
    isBoundedNonNegativeInteger(value.totalLines, CACHE_TOTAL_LINES_MAX)
  );
}

function isModelOutputMetadata(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.truncated === "boolean" &&
    isBoundedNonNegativeInteger(value.totalBytes, CACHE_TOTAL_BYTES_MAX) &&
    isBoundedNonNegativeInteger(value.totalLines, CACHE_TOTAL_LINES_MAX)
  );
}

function isExit(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.code === null || isBoundedNonNegativeInteger(value.code, 255)) &&
    (value.signal === null || isBoundedString(value.signal, 128))
  );
}

function isScope(value: unknown): boolean {
  return (
    isRecord(value) && isBoundedString(value.cwdStrategy, 128) && isBoundedString(value.projectPath)
  );
}

function isErrorContract(value: unknown): boolean {
  return (
    isRecord(value) &&
    isBoundedString(value.code, 256) &&
    isBoundedString(value.category, 256) &&
    isBoundedString(value.explanation) &&
    (value.invalidField === undefined || isBoundedString(value.invalidField, 256)) &&
    (value.suggestedAction === undefined || isBoundedString(value.suggestedAction)) &&
    typeof value.retryable === "boolean" &&
    typeof value.executed === "boolean"
  );
}

function isRelevantInputs(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.files) &&
    value.files.length <= CACHE_ARRAY_MAX_ITEMS &&
    value.files.every(
      (file) => isRecord(file) && file.kind === "file" && isBoundedString(file.path),
    ) &&
    Array.isArray(value.values) &&
    value.values.length <= CACHE_ARRAY_MAX_ITEMS &&
    value.values.every(
      (entry) =>
        isRecord(entry) &&
        entry.kind === "value" &&
        isBoundedString(entry.name, 256) &&
        isBoundedString(entry.value),
    )
  );
}

function isOutputDetails(value: unknown): value is ProjectCommandOutputDetails {
  if (!isRecord(value)) return false;
  return (
    isBoundedString(value.commandId, 256) &&
    isBoundedString(value.projectPath) &&
    isBoundedString(value.fingerprint, 256) &&
    isBoundedString(value.authFingerprint, 256) &&
    (value.resultFingerprint === undefined || isBoundedString(value.resultFingerprint, 256)) &&
    (value.resultFingerprintVersion === undefined || value.resultFingerprintVersion === 1) &&
    (value.policyId === undefined || isBoundedString(value.policyId, 256)) &&
    (value.reusePolicyId === undefined || isBoundedString(value.reusePolicyId, 256)) &&
    isBoundedString(value.toolCallId, 256) &&
    (value.relevantInputs === undefined || isRelevantInputs(value.relevantInputs)) &&
    (value.producerInvocationId === undefined ||
      isBoundedString(value.producerInvocationId, 256)) &&
    (value.producerScope === undefined ||
      value.producerScope === "session" ||
      value.producerScope === "flow") &&
    typeof value.reused === "boolean" &&
    typeof value.forced === "boolean" &&
    isBoundedString(value.cacheDecision, 128) &&
    isBoundedDuration(value.durationMs) &&
    isBoundedDuration(value.executionDurationMs) &&
    isScope(value.scope) &&
    (value.status === "success" ||
      value.status === "nonzero" ||
      value.status === "timeout" ||
      value.status === "spawn-failure" ||
      value.status === "cancelled") &&
    isBoundedString(value.category, 256) &&
    typeof value.executed === "boolean" &&
    (value.error === undefined || isErrorContract(value.error)) &&
    isExit(value.exit) &&
    typeof value.timedOut === "boolean" &&
    typeof value.cancelled === "boolean" &&
    isOutputStream(value.stdout) &&
    isOutputStream(value.stderr) &&
    isRecord(value.output) &&
    isModelOutputMetadata(value.output.stdout) &&
    isModelOutputMetadata(value.output.stderr) &&
    (value.diagnostic === undefined || isBoundedString(value.diagnostic)) &&
    (value.suggestedAction === undefined || isBoundedString(value.suggestedAction)) &&
    isBoundedString(value.resolvedCommand, CACHE_ENTRY_MAX_BYTES) &&
    isRecord(value.parameters) &&
    (value.nodeVersion === undefined || isBoundedString(value.nodeVersion, 256)) &&
    (value.manifestPresent === undefined || typeof value.manifestPresent === "boolean") &&
    (value.scripts === undefined ||
      (Array.isArray(value.scripts) &&
        value.scripts.length <= CACHE_ARRAY_MAX_ITEMS &&
        value.scripts.every((item) => isBoundedString(item, 256)))) &&
    (value.applicableCommands === undefined ||
      (Array.isArray(value.applicableCommands) &&
        value.applicableCommands.length <= CACHE_ARRAY_MAX_ITEMS &&
        value.applicableCommands.every((item) => isBoundedString(item, 256))))
  );
}

function isProvenance(value: unknown): value is ProjectCommandCacheProvenance {
  if (!isRecord(value)) return false;
  return (
    isBoundedString(value.producerSessionId, 256) &&
    (value.producerRole === undefined || isBoundedString(value.producerRole, 256)) &&
    isBoundedString(value.flowId, 64) &&
    isBoundedString(value.repositoryIdentity) &&
    isBoundedString(value.workingDirectory) &&
    isBoundedString(value.head, 256) &&
    isBoundedString(value.dirtyFilesDigest, 256) &&
    isBoundedString(value.snapshotDigest, 256) &&
    typeof value.writeTimestamp === "number" &&
    Number.isFinite(value.writeTimestamp)
  );
}

function isCacheEntry(
  value: unknown,
  logicalRequestKey?: string,
  scopeKey?: string,
): value is DiskCacheRecord {
  if (!isRecord(value)) return false;
  if (
    logicalRequestKey !== undefined &&
    (typeof value.logicalRequestKey !== "string" || value.logicalRequestKey !== logicalRequestKey)
  ) {
    return false;
  }
  if (!isProvenance(value.provenance)) return false;
  return (
    value.cacheFormatVersion === CACHE_ENTRY_FORMAT_VERSION &&
    isBoundedString(value.logicalRequestKey, CACHE_FIELD_MAX_LENGTH) &&
    isBoundedString(value.resultFingerprint, 256) &&
    isOutputDetails(value.details) &&
    isStateSnapshot(value.snapshot) &&
    isBoundedString(value.producerInvocationId, 256) &&
    (scopeKey === undefined || value.provenance.flowId === scopeKey)
  );
}

function cacheFileKey(scopeKey: string, logicalRequestKey: string): string {
  return createHash("sha256").update(scopeKey).update("\0").update(logicalRequestKey).digest("hex");
}

function safeScopeKey(value: string): boolean {
  return CACHE_SCOPE_PATTERN.test(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function createDiskCachePath(rootDirectory: string, scopeKey: string): string | undefined {
  if (!safeScopeKey(scopeKey)) return undefined;
  return join(rootDirectory, "flows", scopeKey, "project-command");
}

function claimPathFor(filePath: string): string {
  return filePath.replace(/\.json$/u, ".claim");
}

function readDiskRecord(
  filePath: string,
  logicalRequestKey: string,
  scopeKey: string,
  now: number,
  maxAgeMs: number,
  validate: ProjectCommandDiskCacheRecordValidator,
): unknown {
  try {
    const fileStats = statSync(filePath);
    if (fileStats.size > CACHE_ENTRY_MAX_BYTES) return undefined;
    if (now - fileStats.mtimeMs > maxAgeMs) return undefined;
    const serialized = readFileSync(filePath, "utf8");
    if (Buffer.byteLength(serialized, "utf8") > CACHE_ENTRY_MAX_BYTES) return undefined;
    const parsed: unknown = JSON.parse(serialized);
    if (!validate(parsed, logicalRequestKey, scopeKey)) return undefined;
    const writeTimestamp =
      isRecord(parsed) && isProvenance(parsed.provenance)
        ? parsed.provenance.writeTimestamp
        : undefined;
    if (
      writeTimestamp !== undefined &&
      (now - writeTimestamp > maxAgeMs || writeTimestamp > now + 60_000)
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function removeFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (!isMissing(error)) return;
  }
}

interface CacheLockHandle {
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

function acquireLock(
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

function releaseOwnedLock(handle: CacheLockHandle): void {
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

function acquireGlobalMutationLock(
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

function evictDirectory(directory: string, now: number, maxAgeMs: number, maxBytes: number): void {
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

/** A process-local cache used when no flow-scoped persistence is authorized. */
export function createProjectCommandResultCache(): ProjectCommandResultCache {
  const sessions = new Map<string, Map<string, ProjectCommandResultCacheEntry>>();
  return {
    get(sessionId, logicalRequestKey) {
      return sessions.get(sessionId)?.get(logicalRequestKey);
    },
    set(sessionId, entry) {
      let entries = sessions.get(sessionId);
      if (entries === undefined) {
        entries = new Map();
        sessions.set(sessionId, entries);
      }
      entries.set(entry.logicalRequestKey, entry);
    },
    delete(sessionId, logicalRequestKey) {
      const entries = sessions.get(sessionId);
      if (entries === undefined) return;
      entries.delete(logicalRequestKey);
      if (entries.size === 0) sessions.delete(sessionId);
    },
    clear() {
      sessions.clear();
    },
  };
}

function createProjectCommandDiskJsonCacheInternal(
  options: ProjectCommandDiskResultCacheOptions,
  validate: ProjectCommandDiskCacheRecordValidator,
): ProjectCommandDiskJsonCache {
  const rootDirectory = options.rootDirectory ?? DEFAULT_CACHE_ROOT;
  const allowedScopeKey = options.scopeKey;
  const maxAgeMs =
    options.maxAgeMs !== undefined && Number.isFinite(options.maxAgeMs) && options.maxAgeMs >= 0
      ? options.maxAgeMs
      : DEFAULT_CACHE_MAX_AGE_MS;
  const maxBytes =
    options.maxBytes !== undefined && Number.isFinite(options.maxBytes) && options.maxBytes > 0
      ? options.maxBytes
      : DEFAULT_CACHE_MAX_BYTES;
  const now = options.now ?? Date.now;
  const authorizedScopeFor = (requestedScopeKey: string | undefined): string | undefined => {
    const orchestration = readProjectCommandOrchestrationContext();
    if (
      orchestration.configuredScope !== "flow" ||
      orchestration.effectiveScope !== "flow" ||
      orchestration.flowId === undefined
    ) {
      return undefined;
    }
    if (allowedScopeKey !== undefined && allowedScopeKey !== orchestration.flowId) {
      return undefined;
    }
    if (requestedScopeKey !== undefined && requestedScopeKey !== orchestration.flowId) {
      return undefined;
    }
    return orchestration.flowId;
  };
  const claimHandles = new Map<symbol, CacheLockHandle>();
  const fileFor = (scopeKey: string, logicalRequestKey: string): string | undefined => {
    const authorizedScopeKey = authorizedScopeFor(scopeKey);
    if (authorizedScopeKey === undefined || logicalRequestKey.length === 0) return undefined;
    const directory = createDiskCachePath(rootDirectory, authorizedScopeKey);
    if (directory === undefined) return undefined;
    return join(directory, `${cacheFileKey(authorizedScopeKey, logicalRequestKey)}.json`);
  };
  const runMutation = (operation: () => void): boolean => {
    if (options.mutationLock !== undefined) {
      options.mutationLock(operation);
      return true;
    }
    const lock = acquireGlobalMutationLock(rootDirectory, options.beforeStaleOwnerRemoval);
    if (lock === undefined) return false;
    try {
      operation();
      return true;
    } finally {
      releaseOwnedLock(lock);
    }
  };
  return {
    get(scopeKey, logicalRequestKey) {
      const filePath = fileFor(scopeKey, logicalRequestKey);
      if (filePath === undefined) return undefined;
      return readDiskRecord(filePath, logicalRequestKey, scopeKey, now(), maxAgeMs, validate);
    },
    set(scopeKey, logicalRequestKey, record) {
      const authorizedScopeKey = authorizedScopeFor(scopeKey);
      if (authorizedScopeKey === undefined || logicalRequestKey.length === 0) return;
      const directory = createDiskCachePath(rootDirectory, authorizedScopeKey);
      if (directory === undefined) return;
      const filePath = join(
        directory,
        `${cacheFileKey(authorizedScopeKey, logicalRequestKey)}.json`,
      );
      const timestamp = now();
      let serialized: string;
      try {
        serialized = JSON.stringify(record);
      } catch {
        return;
      }
      if (Buffer.byteLength(serialized, "utf8") > CACHE_ENTRY_MAX_BYTES) return;
      runMutation(() => {
        const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
        try {
          mkdirSync(directory, { recursive: true });
          writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
          options.beforeRename?.(temporaryPath, filePath);
          renameSync(temporaryPath, filePath);
          evictDirectory(directory, timestamp, maxAgeMs, maxBytes);
        } catch {
          removeFile(temporaryPath);
        }
      });
    },
    delete(scopeKey, logicalRequestKey) {
      const filePath = fileFor(scopeKey, logicalRequestKey);
      if (filePath === undefined) return;
      runMutation(() => removeFile(filePath));
    },
    clear() {
      const scopeKey = authorizedScopeFor(undefined);
      const directory =
        scopeKey === undefined ? undefined : createDiskCachePath(rootDirectory, scopeKey);
      if (directory === undefined) return;
      runMutation(() => {
        try {
          for (const name of readdirSync(directory)) removeFile(join(directory, name));
        } catch {
          // A missing cache directory is already clear.
        }
      });
    },
    tryClaim(scopeKey, logicalRequestKey) {
      const filePath = fileFor(scopeKey, logicalRequestKey);
      if (filePath === undefined) return undefined;
      const claimPath = claimPathFor(filePath);
      let claim: ProjectCommandDiskCacheClaim | undefined;
      if (
        !runMutation(() => {
          try {
            mkdirSync(join(rootDirectory, "flows", scopeKey, "project-command"), {
              recursive: true,
            });
          } catch {
            return;
          }
          const lock = acquireLock(claimPath, Date.now(), options.beforeStaleOwnerRemoval);
          if (lock === undefined) return;
          claim = { claimId: Symbol() };
          claimHandles.set(claim.claimId, lock);
        })
      ) {
        return undefined;
      }
      return claim;
    },
    releaseClaim(claim) {
      const lock = claimHandles.get(claim.claimId);
      if (lock === undefined) return;
      claimHandles.delete(claim.claimId);
      releaseOwnedLock(lock);
    },
  };
}

export function createProjectCommandDiskJsonCache(
  options: ProjectCommandDiskResultCacheOptions = {},
  validate: ProjectCommandDiskCacheRecordValidator,
): ProjectCommandDiskJsonCache {
  return createProjectCommandDiskJsonCacheInternal(options, validate);
}

export function createProjectCommandDiskResultCache(
  options: ProjectCommandDiskResultCacheOptions = {},
): ProjectCommandResultCache {
  const store = createProjectCommandDiskJsonCacheInternal(options, isCacheEntry);
  return {
    get(scopeKey, logicalRequestKey) {
      const entry = store.get(scopeKey, logicalRequestKey);
      return isCacheEntry(entry) ? entry : undefined;
    },
    set(scopeKey, entry) {
      const timestamp = options.now?.() ?? Date.now();
      store.set(scopeKey, entry.logicalRequestKey, {
        cacheFormatVersion: CACHE_ENTRY_FORMAT_VERSION,
        ...entry,
        ...(entry.provenance === undefined
          ? {}
          : { provenance: { ...entry.provenance, writeTimestamp: timestamp } }),
      });
    },
    delete(scopeKey, logicalRequestKey) {
      store.delete(scopeKey, logicalRequestKey);
    },
    clear() {
      store.clear();
    },
  };
}

export function projectCommandDefaultCacheRoot(): string {
  return DEFAULT_CACHE_ROOT;
}
