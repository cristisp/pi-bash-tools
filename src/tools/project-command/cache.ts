import type { ProjectCommandOutputDetails } from "./output.ts";
import type { ProjectCommandStateSnapshot } from "./state-snapshot.ts";

export type ProjectCommandCacheDecision = "miss" | "hit" | "forced" | "ineligible" | "invalidated";

export interface ProjectCommandResultCacheEntry {
  readonly logicalRequestKey: string;
  readonly resultFingerprint: string;
  readonly details: ProjectCommandOutputDetails;
  readonly snapshot: ProjectCommandStateSnapshot;
  readonly producerInvocationId: string;
}

export interface ProjectCommandResultCache {
  get(sessionId: string, logicalRequestKey: string): ProjectCommandResultCacheEntry | undefined;
  set(sessionId: string, entry: ProjectCommandResultCacheEntry): void;
  delete(sessionId: string, logicalRequestKey: string): void;
  clear(): void;
}

/** A deliberately process-local, session-scoped result cache. It has no restore or persistence path. */
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
