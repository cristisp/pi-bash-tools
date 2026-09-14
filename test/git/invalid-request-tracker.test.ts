import { describe, expect, it } from "vitest";

import {
  createInvalidRequestTracker,
  invalidRequestFingerprint,
  type InvalidGitRequestKey,
} from "../../src/tools/git/invalid-request-tracker.ts";

function fingerprint(value: unknown): string {
  const result = invalidRequestFingerprint(value);
  if (result === undefined) throw new Error("expected a fingerprint");
  return result;
}

function key(index: number): InvalidGitRequestKey {
  return { sessionId: "session-1", tool: "git_log", fingerprint: fingerprint({ index }) };
}

describe("invalid Git request tracker", () => {
  it("hashes request shapes without retaining their values", () => {
    const digest = fingerprint({ revision: "", path: "secret-path" });

    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(digest).not.toContain("secret-path");
    expect(fingerprint({ revision: "", path: "secret-path" })).toBe(digest);
    expect(fingerprint({ path: "secret-path", revision: "" })).toBe(digest);
  });

  it("declines to fingerprint values that are not JSON-compatible", () => {
    expect(invalidRequestFingerprint(undefined)).toBeUndefined();
    expect(invalidRequestFingerprint(Number.NaN)).toBeUndefined();
    expect(invalidRequestFingerprint(new Set([1]))).toBeUndefined();
  });

  it("remembers and finds an entry, then evicts the oldest entry beyond 256", () => {
    const tracker = createInvalidRequestTracker();

    for (let index = 0; index < 256; index += 1) {
      tracker.rememberUnchangedInvalidRequest(key(index));
    }
    expect(tracker.findUnchangedInvalidRequest(key(0))).toBe(true);

    tracker.rememberUnchangedInvalidRequest(key(256));

    expect(tracker.findUnchangedInvalidRequest(key(0))).toBe(false);
    expect(tracker.findUnchangedInvalidRequest(key(1))).toBe(true);
    expect(tracker.findUnchangedInvalidRequest(key(256))).toBe(true);
  });

  it("refreshes the recency of a remembered entry", () => {
    const tracker = createInvalidRequestTracker();

    tracker.rememberUnchangedInvalidRequest(key(0));
    for (let index = 1; index < 256; index += 1) {
      tracker.rememberUnchangedInvalidRequest(key(index));
    }
    tracker.rememberUnchangedInvalidRequest(key(0));
    tracker.rememberUnchangedInvalidRequest(key(256));

    expect(tracker.findUnchangedInvalidRequest(key(0))).toBe(true);
    expect(tracker.findUnchangedInvalidRequest(key(1))).toBe(false);
  });

  it("isolates entries by session and tool", () => {
    const tracker = createInvalidRequestTracker();
    tracker.rememberUnchangedInvalidRequest(key(0));

    expect(tracker.findUnchangedInvalidRequest({ ...key(0), sessionId: "session-2" })).toBe(false);
    expect(tracker.findUnchangedInvalidRequest({ ...key(0), tool: "git_diff" })).toBe(false);
    expect(tracker.findUnchangedInvalidRequest(key(0))).toBe(true);
  });

  it("honors a custom bound", () => {
    const tracker = createInvalidRequestTracker(2);
    tracker.rememberUnchangedInvalidRequest(key(0));
    tracker.rememberUnchangedInvalidRequest(key(1));
    tracker.rememberUnchangedInvalidRequest(key(2));

    expect(tracker.findUnchangedInvalidRequest(key(0))).toBe(false);
    expect(tracker.findUnchangedInvalidRequest(key(2))).toBe(true);
  });
});
