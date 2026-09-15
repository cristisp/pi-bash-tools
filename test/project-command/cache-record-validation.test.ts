import { expect, it } from "vitest";

import { isCacheEntry } from "../../src/tools/project-command/cache/record-validation.ts";
import type { ProjectCommandOutputDetails } from "../../src/tools/project-command/output.ts";

const snapshot = { version: 1 as const, entries: [] };

const cacheDetails = {
  commandId: "workspace_path",
  projectPath: "/repo",
  fingerprint: "fingerprint",
  authFingerprint: "auth-fingerprint",
  toolCallId: "producer",
  reused: false,
  forced: false,
  cacheDecision: "miss" as const,
  durationMs: 1,
  executionDurationMs: 1,
  scope: { cwdStrategy: "canonical-project" as const, projectPath: "/repo" },
  status: "success" as const,
  category: "PASS" as const,
  executed: true,
  exit: { code: 0, signal: null },
  timedOut: false,
  cancelled: false,
  stdout: { text: "value", truncated: false, totalBytes: 5, totalLines: 1 },
  stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
  output: {
    stdout: { truncated: false, totalBytes: 5, totalLines: 1 },
    stderr: { truncated: false, totalBytes: 0, totalLines: 0 },
  },
  resolvedCommand: "/bin/pwd",
  parameters: {},
} satisfies ProjectCommandOutputDetails;

function entry(detailOverrides: Record<string, unknown> = {}) {
  return {
    cacheFormatVersion: 1 as const,
    logicalRequestKey: "request-a",
    resultFingerprint: "fingerprint-a",
    details: { ...cacheDetails, ...detailOverrides },
    snapshot,
    producerInvocationId: "producer-call",
    provenance: {
      producerSessionId: "producer-session",
      producerRole: "worker",
      flowId: "flow-a",
      repositoryIdentity: "/repo",
      workingDirectory: "/repo",
      head: "head-a",
      dirtyFilesDigest: "dirty-a",
      snapshotDigest: "snapshot-a",
      writeTimestamp: 0,
    },
  };
}

it("validates complete cache entries and their key and scope arguments", () => {
  expect(isCacheEntry(entry())).toBe(true);
  expect(isCacheEntry(entry(), "request-a")).toBe(true);
  expect(isCacheEntry(entry(), "request-b")).toBe(false);
  expect(isCacheEntry(entry(), undefined, "flow-a")).toBe(true);
  expect(isCacheEntry(entry(), undefined, "flow-b")).toBe(false);
});

it("enforces the unified command-id, exit, text, and parameters bounds on cache entries", () => {
  const legacyVariant = `node_format:${"v".repeat(128)}`;
  expect(legacyVariant.length).toBe(140);
  expect(isCacheEntry(entry({ commandId: legacyVariant }))).toBe(true);
  expect(isCacheEntry(entry({ commandId: "c".repeat(256) }))).toBe(true);
  expect(isCacheEntry(entry({ commandId: "c".repeat(257) }))).toBe(false);

  const withExit = (code: number | null) => isCacheEntry(entry({ exit: { code, signal: null } }));
  expect(withExit(0)).toBe(true);
  expect(withExit(255)).toBe(true);
  expect(withExit(-1)).toBe(false);
  expect(withExit(256)).toBe(false);

  const withStdoutText = (text: string) =>
    isCacheEntry(
      entry({
        stdout: { text, truncated: false, totalBytes: text.length, totalLines: 1 },
      }),
    );
  expect(withStdoutText("x".repeat(50 * 1024))).toBe(true);
  expect(withStdoutText("x".repeat(50 * 1024 + 1))).toBe(false);

  const parameters = (keys: number) =>
    Object.fromEntries(Array.from({ length: keys }, (_, index) => [`parameter-${index}`, true]));
  expect(isCacheEntry(entry({ parameters: parameters(128) }))).toBe(true);
  expect(isCacheEntry(entry({ parameters: parameters(129) }))).toBe(false);
});
