import type { Stats } from "node:fs";

import { describe, expect, it } from "vitest";

import { createProjectCommandResultFingerprint } from "../../src/tools/project-command/fingerprint.ts";
import type { NodeFileSystem } from "../../src/tools/project-command/node/types.ts";
import { canonicalProjectCommandRelevantInputs } from "../../src/tools/project-command/relevant-inputs.ts";
import {
  projectCommandStateSnapshotDigest,
  snapshotProjectCommandRelevantInputs,
} from "../../src/tools/project-command/state-snapshot.ts";

const inputs = canonicalProjectCommandRelevantInputs([{ kind: "file", path: "input.bin" }]);

function fakeStats({ file, symlink }: { file: boolean; symlink: boolean }): Stats {
  const timestamp = new Date(0);
  return {
    dev: 0,
    ino: 0,
    mode: 0o100644,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: 0,
    size: 2,
    blksize: 4096,
    blocks: 1,
    atimeMs: 0,
    mtimeMs: 123,
    ctimeMs: 456,
    birthtimeMs: 0,
    atime: timestamp,
    mtime: timestamp,
    ctime: timestamp,
    birthtime: timestamp,
    isFile: () => file,
    isDirectory: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => symlink,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

function makeFileSystem(
  content: Uint8Array,
  symlinkTarget?: Uint8Array,
  forceSymlink = false,
): NodeFileSystem {
  const isSymlink = symlinkTarget !== undefined || forceSymlink;
  return {
    readFile: async () => "",
    readFileBytes: async () => content,
    stat: async () => fakeStats({ file: true, symlink: false }),
    lstat: async () => fakeStats({ file: !isSymlink, symlink: isSymlink }),
    ...(symlinkTarget === undefined ? {} : { readlinkBytes: async () => symlinkTarget }),
  };
}

function resultFingerprint(stateDigest: string): string {
  return createProjectCommandResultFingerprint({
    authFingerprint: "auth",
    projectPath: "/project",
    effectiveParameters: Object.freeze({}),
    processTimeoutMs: 30_000,
    outputLimitBytes: 50 * 1024,
    policyId: "policy",
    reusePolicyId: "project-metadata",
    relevantInputs: inputs,
    stateDigest,
  }).fingerprint;
}

async function snapshotDigest(snapshotFileSystem: NodeFileSystem): Promise<{
  readonly digest: string;
  readonly snapshot: Extract<
    Awaited<ReturnType<typeof snapshotProjectCommandRelevantInputs>>,
    { readonly status: "complete" }
  >["snapshot"];
}> {
  const result = await snapshotProjectCommandRelevantInputs("/project", inputs, snapshotFileSystem);
  if (result.status !== "complete") throw new Error(result.reason);
  return {
    digest: projectCommandStateSnapshotDigest(result.snapshot),
    snapshot: result.snapshot,
  };
}

describe("project command state snapshots", () => {
  it("keeps same-size invalid UTF-8 byte sequences distinct in result fingerprints", async () => {
    const before = await snapshotDigest(makeFileSystem(Uint8Array.from([0xc3, 0x28])));
    const after = await snapshotDigest(makeFileSystem(Uint8Array.from([0xe2, 0x28])));

    expect(before.snapshot.entries[0]?.size).toBe(after.snapshot.entries[0]?.size);
    expect(before.snapshot.entries[0]?.contentHash).not.toBe(
      after.snapshot.entries[0]?.contentHash,
    );
    expect(resultFingerprint(before.digest)).not.toBe(resultFingerprint(after.digest));
  });

  it("includes symlink target identity even when target content and metadata are unchanged", async () => {
    const before = await snapshotDigest(
      makeFileSystem(Uint8Array.from([0x61, 0x62]), new TextEncoder().encode("target-a")),
    );
    const after = await snapshotDigest(
      makeFileSystem(Uint8Array.from([0x61, 0x62]), new TextEncoder().encode("target-b")),
    );

    expect(before.snapshot.entries[0]?.type).toBe("symlink");
    expect(after.snapshot.entries[0]?.type).toBe("symlink");
    expect(before.snapshot.entries[0]?.contentHash).toBe(after.snapshot.entries[0]?.contentHash);
    expect(before.snapshot.entries[0]?.symlinkTargetHash).not.toBe(
      after.snapshot.entries[0]?.symlinkTargetHash,
    );
    expect(resultFingerprint(before.digest)).not.toBe(resultFingerprint(after.digest));
  });

  it("fails closed when symlink target identity cannot be read", async () => {
    const result = await snapshotProjectCommandRelevantInputs(
      "/project",
      inputs,
      makeFileSystem(Uint8Array.from([0x61, 0x62]), undefined, true),
    );

    expect(result).toEqual({ status: "incomplete", reason: "state-snapshot-failed" });
  });
});
