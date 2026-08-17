export interface Truncation {
  readonly truncated: boolean;
  readonly totalBytes: number;
  readonly totalLines: number;
}

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
