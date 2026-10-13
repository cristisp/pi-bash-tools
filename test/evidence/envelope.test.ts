import { describe, expect, it } from "vitest";

import {
  EVIDENCE_ENVELOPE_FORMAT_VERSION,
  EVIDENCE_PRODUCER,
  aggregateSharedEvidenceOutput,
  isBoundedSharedEvidenceFields,
  isBoundedSharedEvidenceOutput,
  isBoundedSharedEvidenceRecord,
  isBoundedSharedEvidenceWorkspace,
  sharedEvidenceRequestHash,
  sharedRepositoryId,
  sharedWorkspaceBlock,
} from "../../src/evidence/envelope.ts";

describe("workspace blocks", () => {
  it("hashes the repository identity and keeps workspace digests", () => {
    expect(sharedRepositoryId("/repo")).toMatch(/^[0-9a-f]{64}$/u);
    expect(sharedRepositoryId("/repo")).toBe(sharedRepositoryId("/repo"));
    expect(sharedRepositoryId("/repo")).not.toBe(sharedRepositoryId("/other"));
    expect(
      sharedWorkspaceBlock({ repositoryIdentity: "/repo", head: "HEAD", dirtyFilesDigest: "d" }),
    ).toEqual({
      repositoryId: sharedRepositoryId("/repo"),
      head: "HEAD",
      dirtyDigest: "d",
      status: "readable",
    });
  });

  it("validates bounded workspace blocks", () => {
    expect(
      isBoundedSharedEvidenceWorkspace({
        repositoryId: sharedRepositoryId("/repo"),
        head: null,
        dirtyDigest: null,
        status: "degraded",
      }),
    ).toBe(true);
    expect(isBoundedSharedEvidenceWorkspace({ repositoryId: "short", status: "readable" })).toBe(
      false,
    );
    expect(isBoundedSharedEvidenceWorkspace("workspace")).toBe(false);
  });
});

describe("output blocks", () => {
  it("aggregates stream output metadata", () => {
    expect(
      aggregateSharedEvidenceOutput([
        { truncated: false, totalBytes: 10, totalLines: 3 },
        { truncated: true, totalBytes: 5, totalLines: 2 },
      ]),
    ).toEqual({ truncated: true, totalBytes: 15, totalLines: 5 });
    expect(aggregateSharedEvidenceOutput([])).toEqual({
      truncated: false,
      totalBytes: 0,
      totalLines: 0,
    });
  });

  it("validates bounded output blocks", () => {
    expect(isBoundedSharedEvidenceOutput({ truncated: true, totalBytes: 0, totalLines: 0 })).toBe(
      true,
    );
    expect(
      isBoundedSharedEvidenceOutput({ truncated: false, totalBytes: 1.5, totalLines: 0 }),
    ).toBe(false);
    expect(isBoundedSharedEvidenceOutput({ truncated: false, totalBytes: 0 })).toBe(false);
  });
});

describe("envelope validators", () => {
  const validRecord = {
    evidenceFormatVersion: EVIDENCE_ENVELOPE_FORMAT_VERSION,
    ref: "vr_test",
    producer: EVIDENCE_PRODUCER,
    kind: "verify",
    scope: "session",
    requestHash: "a".repeat(64),
    contentHash: "b".repeat(64),
  };

  it("accepts a bounded record", () => {
    expect(isBoundedSharedEvidenceRecord(validRecord, ["verify"])).toBe(true);
  });

  it("rejects records outside the producer, kind, scope, or hash contracts", () => {
    expect(isBoundedSharedEvidenceRecord(validRecord, [])).toBe(false);
    expect(
      isBoundedSharedEvidenceRecord({ ...validRecord, producer: "codegraph-runner" }, ["verify"]),
    ).toBe(false);
    expect(isBoundedSharedEvidenceRecord({ ...validRecord, scope: "root" }, ["verify"])).toBe(
      false,
    );
    expect(
      isBoundedSharedEvidenceRecord({ ...validRecord, requestHash: "short" }, ["verify"]),
    ).toBe(false);
    expect(
      isBoundedSharedEvidenceRecord({ ...validRecord, evidenceFormatVersion: 2 }, ["verify"]),
    ).toBe(false);
  });

  it("validates additive field sets without requiring every field", () => {
    expect(isBoundedSharedEvidenceFields({}, ["verify"])).toBe(true);
    expect(isBoundedSharedEvidenceFields({ kind: "verify" }, ["verify"])).toBe(true);
    expect(isBoundedSharedEvidenceFields({ kind: "explore" }, ["verify"])).toBe(false);
    expect(
      isBoundedSharedEvidenceFields({ workspace: { repositoryId: "short" } }, ["verify"]),
    ).toBe(false);
  });

  it("hashes canonical request identity deterministically", () => {
    expect(sharedEvidenceRequestHash({ b: 1, a: 2 })).toBe(
      sharedEvidenceRequestHash({ a: 2, b: 1 }),
    );
    expect(sharedEvidenceRequestHash({ b: 1, a: 2 })).toMatch(/^[0-9a-f]{64}$/u);
  });
});
