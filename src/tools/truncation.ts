import { Type } from "typebox";

export interface Truncation {
  readonly truncated: boolean;
  readonly totalBytes: number;
  readonly totalLines: number;
}

export const truncationSchema = Type.Object(
  {
    truncated: Type.Boolean({ description: "Whether the result was truncated." }),
    totalBytes: Type.Integer({ description: "Total result bytes before truncation.", minimum: 0 }),
    totalLines: Type.Integer({ description: "Total result lines before truncation.", minimum: 0 }),
  },
  { additionalProperties: false },
);

export function decodeUtf8Prefix(
  bytes: Uint8Array,
  maxBytes: number,
  forceTruncate = false,
): string {
  let end = Math.min(bytes.byteLength, maxBytes);
  if (forceTruncate || bytes.byteLength > maxBytes) {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    while (end > 0) {
      try {
        decoder.decode(bytes.subarray(0, end));
        break;
      } catch {
        end -= 1;
      }
    }
  }
  return new TextDecoder().decode(bytes.subarray(0, end));
}

export function decodeUtf8Suffix(bytes: Uint8Array): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let start = 0; start <= bytes.byteLength; start += 1) {
    try {
      return decoder.decode(bytes.subarray(start));
    } catch {}
  }
  return "";
}
