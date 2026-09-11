import { describe, expect, it } from "vitest";

import {
  sharedRepositoryId,
  sharedWorkspaceBlock,
  type SharedEvidenceWorkspaceBlock,
} from "../../src/evidence/envelope.ts";
import { compareWorkspaceBlocksCrossProducer } from "../../src/evidence/repository-state-comparison.ts";

function block(overrides: {
  head?: string | null;
  dirtyDigest?: string | null;
  status?: "readable" | "degraded";
}): SharedEvidenceWorkspaceBlock {
  return {
    repositoryId: sharedRepositoryId("/repo"),
    head: "abc123",
    dirtyDigest: "def456",
    status: "readable",
    ...overrides,
  };
}

describe("compareWorkspaceBlocksCrossProducer", () => {
  it("returns authoritative with headMatch true when both heads are equal", () => {
    const result = compareWorkspaceBlocksCrossProducer(block({}), block({}));
    expect(result).toEqual({
      comparability: "authoritative",
      headMatch: true,
      reasons: ["head-only"],
    });
  });

  it("returns authoritative with headMatch false when heads differ", () => {
    const result = compareWorkspaceBlocksCrossProducer(block({}), block({ head: "xyz789" }));
    expect(result).toEqual({
      comparability: "authoritative",
      headMatch: false,
      reasons: ["head-only"],
    });
  });

  it("returns incomparable with headMatch null when either head is null", () => {
    const localNull = compareWorkspaceBlocksCrossProducer(
      block({ head: null }),
      block({ head: "xyz789" }),
    );
    const otherNull = compareWorkspaceBlocksCrossProducer(
      block({ head: "abc123" }),
      block({ head: null }),
    );
    const bothNull = compareWorkspaceBlocksCrossProducer(
      block({ head: null }),
      block({ head: null }),
    );
    for (const result of [localNull, otherNull, bothNull]) {
      expect(result).toEqual({
        comparability: "incomparable",
        headMatch: null,
        reasons: ["head-null"],
      });
    }
  });

  it("degraded status on either side forces incomparable and wins over head equality", () => {
    const localDegraded = compareWorkspaceBlocksCrossProducer(
      block({ status: "degraded" }),
      block({}),
    );
    const otherDegraded = compareWorkspaceBlocksCrossProducer(
      block({}),
      block({ status: "degraded" }),
    );
    const bothDegradedSameHead = compareWorkspaceBlocksCrossProducer(
      block({ status: "degraded" }),
      block({ status: "degraded" }),
    );
    const bothDegradedNullHead = compareWorkspaceBlocksCrossProducer(
      block({ status: "degraded", head: null }),
      block({ status: "degraded", head: null }),
    );
    for (const result of [
      localDegraded,
      otherDegraded,
      bothDegradedSameHead,
      bothDegradedNullHead,
    ]) {
      expect(result).toEqual({
        comparability: "incomparable",
        headMatch: null,
        reasons: ["status-degraded"],
      });
    }
  });

  it("never lets repositoryId or dirtyDigest values influence the result", () => {
    const same = compareWorkspaceBlocksCrossProducer(
      block({ dirtyDigest: "same" }),
      block({ dirtyDigest: "same" }),
    );
    const different = compareWorkspaceBlocksCrossProducer(
      block({ dirtyDigest: "same" }),
      block({ dirtyDigest: "other" }),
    );
    const differentIds = compareWorkspaceBlocksCrossProducer(
      {
        repositoryId: sharedRepositoryId("/repo-a"),
        head: "abc123",
        dirtyDigest: "same",
        status: "readable",
      },
      {
        repositoryId: sharedRepositoryId("/repo-b"),
        head: "abc123",
        dirtyDigest: "same",
        status: "readable",
      },
    );
    for (const result of [same, different, differentIds]) {
      expect(result).toEqual({
        comparability: "authoritative",
        headMatch: true,
        reasons: ["head-only"],
      });
    }
    expect(
      compareWorkspaceBlocksCrossProducer(
        sharedWorkspaceBlock({
          repositoryIdentity: "/repo-a",
          head: "abc123",
          dirtyFilesDigest: "def456",
        }),
        sharedWorkspaceBlock({
          repositoryIdentity: "/repo-b",
          head: "abc123",
          dirtyFilesDigest: "def456",
        }),
      ),
    ).toEqual({
      comparability: "authoritative",
      headMatch: true,
      reasons: ["head-only"],
    });
  });

  it("returns bounded short reason strings and a frozen result", () => {
    const results = [
      compareWorkspaceBlocksCrossProducer(block({}), block({})),
      compareWorkspaceBlocksCrossProducer(block({ head: null }), block({})),
      compareWorkspaceBlocksCrossProducer(block({ status: "degraded" }), block({})),
    ];
    for (const result of results) {
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.reasons)).toBe(true);
      for (const reason of result.reasons) {
        expect(typeof reason).toBe("string");
        expect(reason.length).toBeGreaterThan(0);
        expect(reason.length).toBeLessThanOrEqual(64);
      }
    }
  });
});
