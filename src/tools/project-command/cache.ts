import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { isRecord } from "../value-validation.ts";
import {
  acquireGlobalMutationLock,
  acquireLock,
  evictDirectory,
  releaseOwnedLock,
  removeFile,
  type CacheLockHandle,
} from "./cache/locking.ts";
import { isCacheEntry, isCacheProvenance } from "./cache/record-validation.ts";
import { readProjectCommandOrchestrationContext } from "./orchestration.ts";
import type { ProjectCommandOutputDetails } from "./output.ts";
import type { ProjectCommandStateSnapshot } from "./state-snapshot.ts";

export { createProjectCommandResultCache } from "./cache/memory.ts";

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
  set(scopeKey: string, logicalRequestKey: string, record: unknown): boolean;
  /** Write an explicitly authorized publication without deriving scope from the environment. */
  publish(scopeKey: string, logicalRequestKey: string, record: unknown): boolean;
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
const CACHE_SCOPE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

function cacheFileKey(scopeKey: string, logicalRequestKey: string): string {
  return createHash("sha256").update(scopeKey).update("\0").update(logicalRequestKey).digest("hex");
}

function safeScopeKey(value: string): boolean {
  return CACHE_SCOPE_PATTERN.test(value);
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
      isRecord(parsed) && isCacheProvenance(parsed.provenance)
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
  const writeRecord = (
    authorizedScopeKey: string,
    logicalRequestKey: string,
    record: unknown,
  ): boolean => {
    if (logicalRequestKey.length === 0) return false;
    const directory = createDiskCachePath(rootDirectory, authorizedScopeKey);
    if (directory === undefined) return false;
    const filePath = join(directory, `${cacheFileKey(authorizedScopeKey, logicalRequestKey)}.json`);
    const timestamp = now();
    let serialized: string;
    try {
      serialized = JSON.stringify(record);
    } catch {
      return false;
    }
    if (Buffer.byteLength(serialized, "utf8") > CACHE_ENTRY_MAX_BYTES) return false;
    let wrote = false;
    const locked = runMutation(() => {
      const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        mkdirSync(directory, { recursive: true });
        writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
        options.beforeRename?.(temporaryPath, filePath);
        renameSync(temporaryPath, filePath);
        wrote = true;
        evictDirectory(directory, timestamp, maxAgeMs, maxBytes);
      } catch {
        removeFile(temporaryPath);
      }
    });
    return locked && wrote;
  };
  return {
    get(scopeKey, logicalRequestKey) {
      const filePath = fileFor(scopeKey, logicalRequestKey);
      if (filePath === undefined) return undefined;
      return readDiskRecord(filePath, logicalRequestKey, scopeKey, now(), maxAgeMs, validate);
    },
    set(scopeKey, logicalRequestKey, record) {
      const authorizedScopeKey = authorizedScopeFor(scopeKey);
      if (authorizedScopeKey === undefined) return false;
      return writeRecord(authorizedScopeKey, logicalRequestKey, record);
    },
    publish(scopeKey, logicalRequestKey, record) {
      if (!CACHE_SCOPE_PATTERN.test(scopeKey)) return false;
      return writeRecord(scopeKey, logicalRequestKey, record);
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
