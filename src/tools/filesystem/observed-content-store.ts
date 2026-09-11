import { createHash } from "node:crypto";

export const DEFAULT_MAX_ENTRIES = 256;

export interface ObservedContentStore {
  record(path: string, contentHash: string): void;
  lookup(path: string): string | undefined;
}

function pathKey(path: string): string {
  return createHash("sha256").update(path, "utf8").digest("hex");
}

/**
 * Create a bounded in-memory map of the most recently observed content hashes by path.
 * Hash-only and best-effort: entries are hints for edit diagnostics and a missing
 * entry degrades to a plain no-match classification.
 */
export function createObservedContentStore(maxEntries: number = DEFAULT_MAX_ENTRIES) {
  const entries = new Map<string, string>();
  return {
    record(path: string, contentHash: string): void {
      try {
        if (path.length === 0 || contentHash.length === 0) return;
        const key = pathKey(path);
        entries.delete(key);
        entries.set(key, contentHash);
        while (entries.size > maxEntries) {
          const oldest = entries.keys().next();
          if (oldest.done) return;
          entries.delete(oldest.value);
        }
      } catch {
        return;
      }
    },
    lookup(path: string): string | undefined {
      try {
        if (path.length === 0) return undefined;
        return entries.get(pathKey(path));
      } catch {
        return undefined;
      }
    },
  };
}

const observedContentStore = createObservedContentStore();

/** Record the content hash observed for a canonical path. Best-effort; never throws. */
export function recordObservedContent(path: string, contentHash: string): void {
  observedContentStore.record(path, contentHash);
}

/** Look up the last observed content hash for a canonical path, if any. */
export function lookupObservedContentHash(path: string): string | undefined {
  return observedContentStore.lookup(path);
}
