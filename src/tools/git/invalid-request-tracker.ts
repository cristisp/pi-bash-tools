import { hashCanonicalJson } from "../../observability/canonical-json.ts";
import type { GitInvocationToolName } from "../../observability/git-invocation.ts";

export interface InvalidGitRequestKey {
  readonly sessionId: string;
  readonly tool: GitInvocationToolName;
  readonly fingerprint: string;
}

export interface InvalidGitRequestTracker {
  rememberUnchangedInvalidRequest(key: InvalidGitRequestKey): void;
  findUnchangedInvalidRequest(key: InvalidGitRequestKey): boolean;
}

const DEFAULT_MAX_ENTRIES = 256;

function trackerKey(key: InvalidGitRequestKey): string {
  return `${key.sessionId}\u0000${key.tool}\u0000${key.fingerprint}`;
}

/**
 * Hash an effective request shape into a bounded fingerprint. Canonicalization rejects values
 * that are not JSON-compatible, and a request that cannot be fingerprinted is simply not tracked.
 */
export function invalidRequestFingerprint(value: unknown): string | undefined {
  try {
    return hashCanonicalJson(value);
  } catch {
    return undefined;
  }
}

/**
 * Create a bounded in-memory tracker of shape-deterministic Git request rejections for the current
 * process. Only hashed fingerprints and opaque identifiers are stored, and entries expire purely
 * through FIFO eviction: no wall-clock state and no persistence.
 */
export function createInvalidRequestTracker(
  maxEntries: number = DEFAULT_MAX_ENTRIES,
): InvalidGitRequestTracker {
  const entries = new Map<string, true>();
  return {
    rememberUnchangedInvalidRequest(key) {
      const mapKey = trackerKey(key);
      entries.delete(mapKey);
      entries.set(mapKey, true);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) return;
        entries.delete(oldest.value);
      }
    },
    findUnchangedInvalidRequest(key) {
      return entries.has(trackerKey(key));
    },
  };
}
