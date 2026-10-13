import { readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_CACHE_MAX_AGE_MS,
  DEFAULT_CACHE_MAX_BYTES,
  defaultCacheRoot,
} from "../tools/project-command/cache.ts";
import {
  CACHE_LOCK_TIMEOUT_MS,
  acquireGlobalMutationLock,
  evictDirectory,
  reclaimOrphanTemps,
  reclaimStaleClaims,
  releaseOwnedLock,
  type EvictionResult,
} from "../tools/project-command/cache/locking.ts";

export interface EvidenceCachePruneSummary extends EvictionResult {
  readonly ownership: "pruned" | "skipped-lock-busy";
  readonly scannedDirectories: number;
  readonly truncated: boolean;
  readonly reclaimedTempFiles: number;
  readonly reclaimedStaleClaims: number;
  readonly removedEmptyDirectories: number;
}

export interface EvidenceCachePruneOptions {
  readonly rootDirectory?: string;
  readonly maxAgeMs?: number;
  readonly maxBytes?: number;
  /** Wall-clock budget for the scan; the pass stops between directories when exceeded. */
  readonly timeBudgetMs?: number;
  readonly now?: () => number;
  readonly mutationLock?: (operation: () => void) => void | boolean;
  /** Orphan temp files older than this are reclaimed by the sweep. */
  readonly orphanTempMinAgeMs?: number;
  /** Claim locks idle longer than this are stale and reclaimed by the sweep. */
  readonly claimMaxIdleMs?: number;
}

const ORPHAN_TEMP_MIN_AGE_MS = 60_000;

interface PruneConfig {
  readonly rootDirectory: string;
  readonly maxAgeMs: number;
  readonly maxBytes: number;
  readonly deadline: number;
  readonly orphanTempMinAgeMs: number;
  readonly claimMaxIdleMs: number;
  readonly now: () => number;
}

interface PruneScanResult extends EvictionResult {
  readonly scannedDirectories: number;
  readonly truncated: boolean;
  readonly reclaimedTempFiles: number;
  readonly reclaimedStaleClaims: number;
}

type PruneRunner = (operation: () => void) => boolean;

const skippedSummary: EvidenceCachePruneSummary = {
  ownership: "skipped-lock-busy",
  scannedDirectories: 0,
  removedFiles: 0,
  removedBytes: 0,
  truncated: false,
  reclaimedTempFiles: 0,
  reclaimedStaleClaims: 0,
  removedEmptyDirectories: 0,
};

function familyDirectories(scopePath: string): string[] {
  try {
    return readdirSync(scopePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(scopePath, entry.name));
  } catch {
    return [];
  }
}

function collectFlowDirectories(rootDirectory: string): string[] {
  const directories: string[] = [];
  let scopeEntries;
  try {
    scopeEntries = readdirSync(join(rootDirectory, "flows"), { withFileTypes: true });
  } catch {
    return directories;
  }
  for (const scope of scopeEntries) {
    if (!scope.isDirectory()) continue;
    directories.push(...familyDirectories(join(rootDirectory, "flows", scope.name)));
  }
  return directories;
}

/**
 * Remove flow directory trees left empty by the sweep. Writers recreate missing
 * directories on demand, and the sweep holds the same global mutation lock as
 * writers, so removing an empty tree cannot race a concurrent write.
 */
function removeEmptyFlowDirectories(rootDirectory: string): number {
  const flowsPath = join(rootDirectory, "flows");
  let scopeEntries;
  try {
    scopeEntries = readdirSync(flowsPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const scope of scopeEntries) {
    if (!scope.isDirectory()) continue;
    const scopePath = join(flowsPath, scope.name);
    let familyEntries;
    try {
      familyEntries = readdirSync(scopePath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const family of familyEntries) {
      if (!family.isDirectory()) continue;
      try {
        rmdirSync(join(scopePath, family.name));
        removed += 1;
      } catch {
        // Not empty; leave it in place.
      }
    }
    try {
      rmdirSync(scopePath);
      removed += 1;
    } catch {
      // Not empty; leave it in place.
    }
  }
  try {
    rmdirSync(flowsPath);
    removed += 1;
  } catch {
    // Not empty or already removed; leave it in place.
  }
  return removed;
}

function pruneDirectories(directories: string[], config: PruneConfig): PruneScanResult {
  let removedFiles = 0;
  let removedBytes = 0;
  let scannedDirectories = 0;
  let truncated = false;
  let reclaimedTempFiles = 0;
  let reclaimedStaleClaims = 0;
  for (const directory of directories) {
    const at = config.now();
    if (at > config.deadline) {
      truncated = true;
      break;
    }
    const result = evictDirectory(directory, at, config.maxAgeMs, config.maxBytes);
    const temps = reclaimOrphanTemps(directory, at, config.orphanTempMinAgeMs);
    const claims = reclaimStaleClaims(directory, at, config.claimMaxIdleMs);
    scannedDirectories += 1;
    removedFiles += result.removedFiles;
    removedBytes += result.removedBytes + claims.removedBytes;
    reclaimedTempFiles += temps.removedFiles;
    reclaimedStaleClaims += claims.removedClaims;
  }
  return {
    removedFiles,
    removedBytes,
    scannedDirectories,
    truncated,
    reclaimedTempFiles,
    reclaimedStaleClaims,
  };
}

function mutationLockRunner(mutationLock: (operation: () => void) => void | boolean): PruneRunner {
  return (operation) => mutationLock(operation) !== false;
}

function globalLockRunner(rootDirectory: string): PruneRunner {
  return (operation) => {
    const lock = acquireGlobalMutationLock(rootDirectory);
    if (lock === undefined) return false;
    try {
      operation();
      return true;
    } finally {
      releaseOwnedLock(lock);
    }
  };
}

export function pruneEvidenceCaches(
  options: EvidenceCachePruneOptions = {},
): EvidenceCachePruneSummary {
  const now = options.now ?? Date.now;
  const config: PruneConfig = {
    rootDirectory: options.rootDirectory ?? defaultCacheRoot(),
    maxAgeMs: options.maxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS,
    maxBytes: options.maxBytes ?? DEFAULT_CACHE_MAX_BYTES,
    deadline: now() + (options.timeBudgetMs ?? 2_000),
    orphanTempMinAgeMs: options.orphanTempMinAgeMs ?? ORPHAN_TEMP_MIN_AGE_MS,
    claimMaxIdleMs: options.claimMaxIdleMs ?? CACHE_LOCK_TIMEOUT_MS,
    now,
  };
  const directories = collectFlowDirectories(config.rootDirectory);
  const runner =
    options.mutationLock !== undefined
      ? mutationLockRunner(options.mutationLock)
      : globalLockRunner(config.rootDirectory);

  let scan: PruneScanResult | undefined;
  let removedEmptyDirectories = 0;
  const locked = runner(() => {
    scan = pruneDirectories(directories, config);
    removedEmptyDirectories = removeEmptyFlowDirectories(config.rootDirectory);
  });

  if (!locked || scan === undefined) return skippedSummary;
  return { ownership: "pruned", ...scan, removedEmptyDirectories };
}

export function describeEvidenceCachePrune(summary: EvidenceCachePruneSummary): string {
  if (summary.ownership === "skipped-lock-busy") {
    return "bash-tools cache prune skipped: another session holds the cache lock";
  }
  if (summary.scannedDirectories === 0) {
    return "bash-tools cache prune found no flow cache directories";
  }
  if (
    summary.removedFiles === 0 &&
    summary.reclaimedTempFiles === 0 &&
    summary.reclaimedStaleClaims === 0 &&
    summary.removedEmptyDirectories === 0
  ) {
    return `bash-tools cache is clean: ${summary.scannedDirectories} flow directories, nothing to prune`;
  }
  const parts: string[] = [];
  if (summary.removedFiles > 0) {
    const plural = summary.removedFiles === 1 ? "record" : "records";
    parts.push(
      `pruned ${summary.removedFiles} ${plural} (${summary.removedBytes} bytes) across ${summary.scannedDirectories} flow directories`,
    );
  }
  if (summary.reclaimedTempFiles > 0) {
    const plural = summary.reclaimedTempFiles === 1 ? "file" : "files";
    parts.push(`reclaimed ${summary.reclaimedTempFiles} orphan temp ${plural}`);
  }
  if (summary.reclaimedStaleClaims > 0) {
    const plural = summary.reclaimedStaleClaims === 1 ? "lock" : "locks";
    parts.push(`reclaimed ${summary.reclaimedStaleClaims} stale claim ${plural}`);
  }
  if (summary.removedEmptyDirectories > 0) {
    const plural = summary.removedEmptyDirectories === 1 ? "directory" : "directories";
    parts.push(`removed ${summary.removedEmptyDirectories} empty ${plural}`);
  }
  const head = `bash-tools cache ${parts.join(" and ")}`;
  return summary.truncated ? `${head}; stopped at the time budget, run again to continue` : head;
}
