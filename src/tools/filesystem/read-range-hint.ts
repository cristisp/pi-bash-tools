import {
  isReadToolResult,
  type ToolResultEvent,
  type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";

import { readResultText } from "./read-result-text.ts";

const DEFAULT_MIN_HINT_BYTES = 32_768;

const RANGE_HINT_SUFFIX =
  "Informational: this whole-file read returned a large file. When you only need part of it, call read_batch with a bounded line range (range: { offset, limit }) instead of re-reading the whole file.";

export interface ReadRangeHint {
  handler: (event: ToolResultEvent) => ToolResultEventResult | undefined;
}

export function createReadRangeHint(options: { readonly minBytes?: number } = {}): ReadRangeHint {
  const minBytes = options.minBytes ?? DEFAULT_MIN_HINT_BYTES;
  return {
    handler(event) {
      try {
        if (!isReadToolResult(event)) return undefined;
        const text = readResultText(event);
        if (text === undefined) return undefined;
        const input = event.input;
        if (input === null || typeof input !== "object") return undefined;
        if (input.offset !== undefined || input.limit !== undefined) return undefined;
        const truncated = event.details?.truncation !== undefined;
        if (!truncated && Buffer.byteLength(text, "utf8") < minBytes) return undefined;
        return {
          content: [...event.content, { type: "text", text: RANGE_HINT_SUFFIX }],
          ...(event.structuredContent === undefined
            ? {}
            : { structuredContent: event.structuredContent }),
          isError: false,
        };
      } catch {
        return undefined;
      }
    },
  };
}
