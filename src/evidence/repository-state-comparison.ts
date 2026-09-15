import type { SharedEvidenceWorkspaceBlock } from "./envelope.ts";

export type WorkspaceBlockStateStatus = "matches" | "mismatch" | "unreadable";

/** Same-producer workspace freshness: full identity comparison with a fail-closed default. */
export function compareWorkspaceBlocks(
  recorded: SharedEvidenceWorkspaceBlock | undefined,
  current: SharedEvidenceWorkspaceBlock | undefined,
): WorkspaceBlockStateStatus {
  if (recorded === undefined || current === undefined) return "unreadable";
  if (recorded.status === "degraded" || current.status === "degraded") return "unreadable";
  if (recorded.repositoryId !== current.repositoryId) return "mismatch";
  if (
    recorded.head === null ||
    current.head === null ||
    recorded.dirtyDigest === null ||
    current.dirtyDigest === null
  ) {
    return "mismatch";
  }
  return recorded.head === current.head && recorded.dirtyDigest === current.dirtyDigest
    ? "matches"
    : "mismatch";
}
