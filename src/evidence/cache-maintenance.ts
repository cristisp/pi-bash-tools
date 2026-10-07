import { readdirSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_CACHE_MAX_AGE_MS,
  DEFAULT_CACHE_MAX_BYTES,
  defaultCacheRoot,
} from "../tools/project-command/cache.ts";
import {
  acquireGlobalMutationLock,
  evictDirectory,
  reclaimOrphanTemps,
  releaseOwnedLock,
  type EvictionResult,
} from "../tools/project-command/cache/locking.ts";

export interface EvidenceCachePruneSummary extends EvictionResult {
  readonly ownership: "pruned" | "skipped-lock-busy";
  readonly scannedDirectories: number;
  readonly truncated: boolean;
  readonly reclaimedTempFiles: number;
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
}

const ORPHAN_TEMP_MIN_AGE_MS = 60_000;

interface PruneConfig {
  readonly rootDirectory: string;
  readonly maxAgeMs: number;
  readonly maxBytes: number;
  readonly deadline: number;
  readonly orphanTempMinAgeMs: number;
  readonly now: () => number;
}

interface PruneScanResult extends EvictionResult {
  readonly scannedDirectories: number;
  readonly truncated: boolean;
}

type PruneRunner = (operation: () => void) => boolean;

const skippedSummary: EvidenceCachePruneSummary = {
  ownership: "skipped-lock-busy",
  scannedDirectories: 0,
  removedFiles: 0,
  removedBytes: 0,
  truncated: false,
  reclaimedTempFiles: 0,
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

interface PruneScanResult extends EvictionResult {
  readonly scannedDirectories: number;
  readonly truncated: boolean;
  readonly reclaimedTempFiles: number;
}

function pruneDirectories(directories: string[], config: PruneConfig): PruneScanResult {
  let removedFiles = 0;
  let removedBytes = 0;
  let scannedDirectories = 0;
  let truncated = false;
  let reclaimedTempFiles = 0;
  for (const directory of directories) {
    if (config.now() > config.deadline) {
      truncated = true;
      break;
    }
    const result = evictDirectory(directory, config.now(), config.maxAgeMs, config.maxBytes);
    const temps = reclaimOrphanTemps(directory, config.now(), config.orphanTempMinAgeMs);
    scannedDirectories += 1;
    removedFiles += result.removedFiles;
    removedBytes += result.removedBytes;
    reclaimedTempFiles += temps.removedFiles;
  }
  return { removedFiles, removedBytes, scannedDirectories, truncated, reclaimedTempFiles };
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
    now,
  };
  const directories = collectFlowDirectories(config.rootDirectory);
  const runner =
    options.mutationLock !== undefined
      ? mutationLockRunner(options.mutationLock)
      : globalLockRunner(config.rootDirectory);

  let scan: PruneScanResult | undefined;
  const locked = runner(() => {
    scan = pruneDirectories(directories, config);
  });

  if (!locked || scan === undefined) return skippedSummary;
  return { ownership: "pruned", ...scan };
}

export function describeEvidenceCachePrune(summary: EvidenceCachePruneSummary): string {
  if (summary.ownership === "skipped-lock-busy") {
    return "bash-tools cache prune skipped: another session holds the cache lock";
  }
  if (summary.scannedDirectories === 0) {
    return "bash-tools cache prune found no flow cache directories";
  }
  if (summary.removedFiles === 0 && summary.reclaimedTempFiles === 0) {
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
  const head = `bash-tools cache ${parts.join(" and ")}`;
  return summary.truncated ? `${head}; stopped at the time budget, run again to continue` : head;
}
