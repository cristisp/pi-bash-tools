import { createHash } from "node:crypto";

import type { AuthorizationOutcomeSurface } from "../observability/authorization-outcome.ts";

type AuthorizationRetryReason = "denied" | "confirmation-timeout" | "edit-preflight";

export interface AuthorizationRetryKey {
  readonly sessionId: string;
  readonly surface: AuthorizationOutcomeSurface | "filesystem-edit";
  readonly fingerprint: string;
}

interface AuthorizationRetryEntry {
  readonly reason: AuthorizationRetryReason;
  readonly ageMs: number;
}

export interface AuthorizationRetryTracker {
  recordPersistentDenial(key: AuthorizationRetryKey, reason: AuthorizationRetryReason): void;
  findUnchangedRetry(key: AuthorizationRetryKey): AuthorizationRetryEntry | undefined;
}

const DEFAULT_MAX_ENTRIES = 256;

function trackerKey(key: AuthorizationRetryKey): string {
  return `${key.sessionId}\u0000${key.surface}\u0000${key.fingerprint}`;
}

/** Hash an authorization request identity into a bounded fingerprint without storing the value. */
export function authorizationRequestFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

/**
 * Create a bounded in-memory tracker of recent persistent denials for the current process.
 * Session identity keys are hashes plus opaque ids; nothing sensitive is stored.
 */
export function createAuthorizationRetryTracker(
  maxEntries: number = DEFAULT_MAX_ENTRIES,
): AuthorizationRetryTracker {
  const entries = new Map<
    string,
    { readonly reason: AuthorizationRetryReason; readonly recordedAt: number }
  >();
  return {
    recordPersistentDenial(key, reason) {
      const mapKey = trackerKey(key);
      entries.delete(mapKey);
      entries.set(mapKey, { reason, recordedAt: performance.now() });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) return;
        entries.delete(oldest.value);
      }
    },
    findUnchangedRetry(key) {
      const entry = entries.get(trackerKey(key));
      if (entry === undefined) return undefined;
      const ageMs = performance.now() - entry.recordedAt;
      return { reason: entry.reason, ageMs: Number.isFinite(ageMs) && ageMs >= 0 ? ageMs : 0 };
    },
  };
}
