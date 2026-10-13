import { isReadToolResult, type ToolResultEvent } from "@earendil-works/pi-coding-agent";

/**
 * Return the joined text of a native `read` result, or undefined when the event is not a
 * successful text-only native read. Used by the read repeat dedupe and the range hint.
 */
export function readResultText(event: ToolResultEvent): string | undefined {
  if (!isReadToolResult(event)) return undefined;
  if (event.isError) return undefined;
  if (event.parentToolCallId !== undefined) return undefined;
  if (!Array.isArray(event.content)) return undefined;
  let joined: string | undefined;
  for (const part of event.content) {
    if (part.type !== "text") return undefined;
    joined = joined === undefined ? part.text : `${joined}\u0000${part.text}`;
  }
  return joined;
}
