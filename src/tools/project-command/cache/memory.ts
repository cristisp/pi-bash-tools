import type { ProjectCommandResultCache, ProjectCommandResultCacheEntry } from "../cache.ts";

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
