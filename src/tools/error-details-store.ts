export interface ToolErrorDetailsStore {
  readonly record: (toolCallId: string, details: unknown) => void;
  readonly take: (toolCallId: string) => unknown;
}

const MAX_PENDING_ERROR_DETAILS = 128;

export function createToolErrorDetailsStore(): ToolErrorDetailsStore {
  const pending = new Map<string, unknown>();

  return {
    record(toolCallId, details) {
      if (toolCallId.length === 0) return;
      if (!pending.has(toolCallId) && pending.size >= MAX_PENDING_ERROR_DETAILS) {
        const oldest = pending.keys().next().value;
        if (typeof oldest === "string") pending.delete(oldest);
      }
      pending.set(toolCallId, details);
    },
    take(toolCallId) {
      const details = pending.get(toolCallId);
      pending.delete(toolCallId);
      return details;
    },
  };
}
