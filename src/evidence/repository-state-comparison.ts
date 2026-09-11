import type { SharedEvidenceWorkspaceBlock } from "./envelope.ts";

export type CrossProducerComparability = "authoritative" | "incomparable";

export interface CrossProducerStateComparison {
  readonly comparability: CrossProducerComparability;
  readonly headMatch: boolean | null;
  readonly reasons: readonly string[];
}

export function compareWorkspaceBlocksCrossProducer(
  local: SharedEvidenceWorkspaceBlock,
  other: SharedEvidenceWorkspaceBlock,
): CrossProducerStateComparison {
  if (local.status === "degraded" || other.status === "degraded") {
    return Object.freeze({
      comparability: "incomparable",
      headMatch: null,
      reasons: Object.freeze(["status-degraded"]),
    });
  }

  if (local.head === null || other.head === null) {
    return Object.freeze({
      comparability: "incomparable",
      headMatch: null,
      reasons: Object.freeze(["head-null"]),
    });
  }

  return Object.freeze({
    comparability: "authoritative",
    headMatch: local.head === other.head,
    reasons: Object.freeze(["head-only"]),
  });
}
