import { createHash } from "node:crypto";

import type {
  ExtensionContext,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";

import { readResultText } from "./read-result-text.ts";

const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_MAX_ENTRIES_PER_SESSION = 256;

export type ReadRepeatDedupeContext = {
  readonly sessionManager?: Pick<ExtensionContext["sessionManager"], "getSessionId">;
};

interface ReadRepeatEntry {
  readonly contentHash: string;
  readonly toolCallId: string;
}

function sessionKey(ctx: ReadRepeatDedupeContext): string | undefined {
  try {
    const value = ctx.sessionManager?.getSessionId();
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function request(
  event: ToolResultEvent,
): { readonly path: string; readonly key: string } | undefined {
  const input = event.input;
  if (input === null || typeof input !== "object") return undefined;
  const path = input.path;
  if (typeof path !== "string" || path.length === 0) return undefined;
  const offset = typeof input.offset === "number" ? input.offset : "*";
  const limit = typeof input.limit === "number" ? input.limit : "*";
  return { path, key: `${JSON.stringify(path)}|${offset}|${limit}` };
}

function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function unchangedResult(path: string, entry: ReadRepeatEntry): ToolResultEventResult {
  const notice =
    `Unchanged repeat: this read returned the same content as the earlier read of ${path} ` +
    `in this session (tool call ${entry.toolCallId}). The earlier result is still in this ` +
    "conversation and remains the authoritative copy; no content is repeated here.";
  return {
    content: [{ type: "text", text: notice }],
    structuredContent: notice,
    isError: false,
  };
}

export interface ReadRepeatDedupe {
  toolResult: (
    event: ToolResultEvent,
    ctx: ReadRepeatDedupeContext,
  ) => ToolResultEventResult | undefined;
  clear: () => void;
}

export function createReadRepeatDedupe(
  options: {
    readonly maxSessions?: number;
    readonly maxEntriesPerSession?: number;
  } = {},
): ReadRepeatDedupe {
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxEntriesPerSession = options.maxEntriesPerSession ?? DEFAULT_MAX_ENTRIES_PER_SESSION;
  const sessions = new Map<string, Map<string, ReadRepeatEntry>>();

  const touch = (sessionId: string, entries: Map<string, ReadRepeatEntry>): void => {
    sessions.delete(sessionId);
    sessions.set(sessionId, entries);
  };

  const upsert = (sessionId: string, key: string, entry: ReadRepeatEntry): void => {
    let entries = sessions.get(sessionId);
    if (entries === undefined) {
      while (sessions.size >= maxSessions) {
        const oldest = sessions.keys().next();
        if (oldest.done) return;
        sessions.delete(oldest.value);
      }
      entries = new Map<string, ReadRepeatEntry>();
      sessions.set(sessionId, entries);
    } else {
      touch(sessionId, entries);
    }
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > maxEntriesPerSession) {
      const oldest = entries.keys().next();
      if (oldest.done) return;
      entries.delete(oldest.value);
    }
  };

  return {
    toolResult(event, ctx) {
      try {
        const text = readResultText(event);
        if (text === undefined) return undefined;
        const sessionId = sessionKey(ctx);
        if (sessionId === undefined) return undefined;
        const parsed = request(event);
        if (parsed === undefined) return undefined;
        const hash = contentHash(text);
        const entries = sessions.get(sessionId);
        const entry = entries?.get(parsed.key);
        if (entry !== undefined && entry.contentHash === hash && entries !== undefined) {
          touch(sessionId, entries);
          entries.delete(parsed.key);
          entries.set(parsed.key, entry);
          return unchangedResult(parsed.path, entry);
        }
        upsert(sessionId, parsed.key, { contentHash: hash, toolCallId: event.toolCallId });
        return undefined;
      } catch {
        return undefined;
      }
    },
    clear() {
      sessions.clear();
    },
  };
}
