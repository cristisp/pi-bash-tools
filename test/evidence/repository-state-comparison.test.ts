import { describe, expect, it } from "vitest";

import {
  sharedRepositoryId,
  sharedWorkspaceBlock,
  type SharedEvidenceWorkspaceBlock,
} from "../../src/evidence/envelope.ts";
import {
  compareWorkspaceBlocks,
  type WorkspaceBlockStateStatus,
} from "../../src/evidence/repository-state-comparison.ts";

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

describe("compareWorkspaceBlocks", () => {
  it("returns unreadable when either block is missing", () => {
    const statuses: WorkspaceBlockStateStatus[] = [
      compareWorkspaceBlocks(undefined, block({})),
      compareWorkspaceBlocks(block({}), undefined),
      compareWorkspaceBlocks(undefined, undefined),
    ];
    expect(statuses).toEqual(["unreadable", "unreadable", "unreadable"]);
  });

  it("returns unreadable when either block is degraded", () => {
    expect(compareWorkspaceBlocks(block({ status: "degraded" }), block({}))).toBe("unreadable");
    expect(compareWorkspaceBlocks(block({}), block({ status: "degraded" }))).toBe("unreadable");
  });

  it("returns mismatch when repositoryId differs", () => {
    expect(
      compareWorkspaceBlocks(
        block({}),
        sharedWorkspaceBlock({
          repositoryIdentity: "/other-repo",
          head: "abc123",
          dirtyFilesDigest: "def456",
        }),
      ),
    ).toBe("mismatch");
  });

  it("returns mismatch when a digest is null on either side", () => {
    expect(compareWorkspaceBlocks(block({ head: null }), block({}))).toBe("mismatch");
    expect(compareWorkspaceBlocks(block({}), block({ head: null }))).toBe("mismatch");
    expect(compareWorkspaceBlocks(block({ dirtyDigest: null }), block({}))).toBe("mismatch");
    expect(compareWorkspaceBlocks(block({}), block({ dirtyDigest: null }))).toBe("mismatch");
  });

  it("matches only on equal head and dirtyDigest", () => {
    expect(compareWorkspaceBlocks(block({}), block({}))).toBe("matches");
    expect(compareWorkspaceBlocks(block({}), block({ head: "xyz789" }))).toBe("mismatch");
    expect(compareWorkspaceBlocks(block({}), block({ dirtyDigest: "other" }))).toBe("mismatch");
  });
});
