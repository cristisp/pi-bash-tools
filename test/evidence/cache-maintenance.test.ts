import { mkdirSync, existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { pruneEvidenceCaches } from "../../src/evidence/cache-maintenance.ts";
import { createTestScope } from "../project-command/test-scope.ts";

describe("pruneEvidenceCaches", () => {
  const scope = createTestScope();

  afterEach(scope.cleanup);

  async function createRoot(prefix: string): Promise<string> {
    return scope.track(await mkdtemp(join(tmpdir(), prefix)));
  }

  function createFlowRecord(
    root: string,
    scopeName: string,
    name: string,
    bytes: number,
    ageMs: number,
    now: number,
  ): string {
    const directory = join(root, "flows", scopeName, "project-command");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, name);
    writeFileSync(path, "x".repeat(bytes), { encoding: "utf8" });
    utimesSync(path, new Date(now - ageMs), new Date(now - ageMs));
    return path;
  }

  function createOrphanTemp(
    root: string,
    scopeName: string,
    suffix: string,
    bytes: number,
    ageMs: number,
    now: number,
  ): string {
    return createFlowRecord(
      root,
      scopeName,
      `${"a".repeat(64)}.json.1234.${"f".repeat(16)}${suffix}`,
      bytes,
      ageMs,
      now,
    );
  }

  it("removes expired records in every flow directory and keeps fresh records", async () => {
    const root = await createRoot("bash-tools-cache-prune-age-");
    const now = 1_000_000;
    createFlowRecord(root, "flow-a", "expired.json", 10, 8 * 24 * 60 * 60 * 1_000, now);
    createFlowRecord(root, "flow-b", "expired.json", 20, 9 * 24 * 60 * 60 * 1_000, now);
    createFlowRecord(root, "flow-c", "fresh.json", 30, 0, now);

    const summary = pruneEvidenceCaches({ rootDirectory: root, now: () => now });

    expect(summary.ownership).toBe("pruned");
    expect(summary.removedFiles).toBe(2);
    expect(summary.removedBytes).toBe(30);
    expect(summary.truncated).toBe(false);
    expect(existsSync(join(root, "flows", "flow-a", "project-command", "expired.json"))).toBe(
      false,
    );
    expect(existsSync(join(root, "flows", "flow-b", "project-command", "expired.json"))).toBe(
      false,
    );
    expect(existsSync(join(root, "flows", "flow-c", "project-command", "fresh.json"))).toBe(true);
  });

  it("enforces the per-directory byte cap by removing the oldest records", async () => {
    const root = await createRoot("bash-tools-cache-prune-capacity-");
    const now = 1_000_000;
    createFlowRecord(root, "flow-old", "oldest.json", 100, 1_000, now);
    createFlowRecord(root, "flow-old", "older.json", 100, 500, now);
    createFlowRecord(root, "flow-old", "newest.json", 200, 0, now);
    createFlowRecord(root, "flow-new", "kept.json", 200, 0, now);

    const summary = pruneEvidenceCaches({ rootDirectory: root, maxBytes: 250, now: () => now });

    expect(summary.ownership).toBe("pruned");
    expect(summary.removedFiles).toBe(2);
    expect(summary.removedBytes).toBe(200);
    expect(existsSync(join(root, "flows", "flow-old", "project-command", "oldest.json"))).toBe(
      false,
    );
    expect(existsSync(join(root, "flows", "flow-old", "project-command", "older.json"))).toBe(
      false,
    );
    expect(existsSync(join(root, "flows", "flow-old", "project-command", "newest.json"))).toBe(
      true,
    );
    expect(existsSync(join(root, "flows", "flow-new", "project-command", "kept.json"))).toBe(true);
  });

  it("stops at the time budget and reports truncation", async () => {
    const root = await createRoot("bash-tools-cache-prune-budget-");
    const now = 1_000_000;
    const scopes = ["flow-a", "flow-b", "flow-c"];
    for (const scopeName of scopes) {
      createFlowRecord(root, scopeName, "expired.json", 1, 8 * 24 * 60 * 60 * 1_000, now);
    }

    let calls = 0;
    const nowStub = (): number => ((calls += 1) <= 3 ? now : now + 2_000);
    const summary = pruneEvidenceCaches({ rootDirectory: root, now: nowStub, timeBudgetMs: 1_000 });

    expect(summary.ownership).toBe("pruned");
    expect(summary.truncated).toBe(true);
    expect(summary.scannedDirectories).toBeLessThan(scopes.length);
  });

  it("reports a lock-busy skip without touching records", async () => {
    const root = await createRoot("bash-tools-cache-prune-lock-busy-");
    const now = 1_000_000;
    const expiredPath = createFlowRecord(
      root,
      "flow-a",
      "expired.json",
      10,
      8 * 24 * 60 * 60 * 1_000,
      now,
    );

    const summary = pruneEvidenceCaches({
      rootDirectory: root,
      now: () => now,
      mutationLock: () => false,
    });

    expect(summary.ownership).toBe("skipped-lock-busy");
    expect(summary.removedFiles).toBe(0);
    expect(existsSync(expiredPath)).toBe(true);
  });

  it("runs the operation under the provided mutation lock", async () => {
    const root = await createRoot("bash-tools-cache-prune-lock-used-");
    const now = 1_000_000;
    createFlowRecord(root, "flow-a", "expired.json", 10, 8 * 24 * 60 * 60 * 1_000, now);
    const operations: Array<() => void> = [];

    const summary = pruneEvidenceCaches({
      rootDirectory: root,
      now: () => now,
      mutationLock: (operation) => {
        operations.push(operation);
        operation();
        return true;
      },
    });

    expect(operations).toHaveLength(1);
    expect(summary.ownership).toBe("pruned");
    expect(summary.removedFiles).toBe(1);
  });

  it("keeps non-record files untouched", async () => {
    const root = await createRoot("bash-tools-cache-prune-non-record-");
    const now = 1_000_000;
    const directory = join(root, "flows", "flow-a", "project-command");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "stale.lock"), "lock", { encoding: "utf8" });
    writeFileSync(join(directory, "owner-stale.token"), "token", { encoding: "utf8" });
    const expiredPath = join(directory, "expired.json");
    writeFileSync(expiredPath, "record", { encoding: "utf8" });
    utimesSync(
      expiredPath,
      new Date(now - 9 * 24 * 60 * 60 * 1_000),
      new Date(now - 9 * 24 * 60 * 60 * 1_000),
    );

    const summary = pruneEvidenceCaches({ rootDirectory: root, now: () => now });

    expect(summary.removedFiles).toBe(1);
    expect(existsSync(join(directory, "stale.lock"))).toBe(true);
    expect(existsSync(join(directory, "owner-stale.token"))).toBe(true);
    expect(existsSync(expiredPath)).toBe(false);
  });

  it("reclaims orphaned temp files older than the minimum age and keeps everything else", async () => {
    const root = await createRoot("bash-tools-cache-prune-orphans-");
    const now = 1_000_000;
    const stale = createOrphanTemp(root, "flow-a", ".tmp", 40, 120_000, now);
    const fresh = createOrphanTemp(root, "flow-b", ".tmp", 41, 5_000, now);
    const distractor = createOrphanTemp(root, "flow-c", ".saved", 42, 120_000, now);
    const shortHex = createFlowRecord(
      root,
      "flow-d",
      `${"b".repeat(64)}.json.1234.${"f".repeat(8)}.tmp`,
      43,
      120_000,
      now,
    );

    const summary = pruneEvidenceCaches({ rootDirectory: root, now: () => now });

    expect(summary.ownership).toBe("pruned");
    expect(summary.reclaimedTempFiles).toBe(1);
    expect(summary.removedFiles).toBe(0);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(distractor)).toBe(true);
    expect(existsSync(shortHex)).toBe(true);
  });

  it("counts reclaimed temps when records are otherwise clean", async () => {
    const root = await createRoot("bash-tools-cache-prune-temp-count-");
    const now = 1_000_000;
    createOrphanTemp(root, "flow-a", ".tmp", 20, 120_000, now);
    createOrphanTemp(root, "flow-b", ".tmp", 30, 120_000, now);
    createFlowRecord(root, "flow-c", "fresh.json", 10, 0, now);

    const summary = pruneEvidenceCaches({ rootDirectory: root, now: () => now });

    expect(summary.removedFiles).toBe(0);
    expect(summary.reclaimedTempFiles).toBe(2);
  });

  function createClaimLock(
    root: string,
    scopeName: string,
    name: string,
    ageMs: number,
    now: number,
  ): string {
    const directory = join(root, "flows", scopeName, "project-command");
    mkdirSync(directory, { recursive: true });
    const claimPath = join(directory, name);
    mkdirSync(claimPath);
    const ownerPath = join(claimPath, "owner-abc123.token");
    writeFileSync(ownerPath, "token", { encoding: "utf8" });
    const past = new Date(now - ageMs);
    utimesSync(ownerPath, past, past);
    utimesSync(claimPath, past, past);
    return claimPath;
  }

  it("reclaims stale claim locks and keeps fresh ones", async () => {
    const root = await createRoot("bash-tools-cache-prune-claims-");
    const now = 1_000_000;
    const staleClaim = createClaimLock(root, "flow-a", "a".repeat(64) + ".claim", 60_000, now);
    const freshClaim = createClaimLock(root, "flow-b", "b".repeat(64) + ".claim", 0, now);

    const summary = pruneEvidenceCaches({ rootDirectory: root, now: () => now });

    expect(summary.ownership).toBe("pruned");
    expect(summary.reclaimedStaleClaims).toBe(1);
    expect(existsSync(staleClaim)).toBe(false);
    expect(existsSync(freshClaim)).toBe(true);
  });

  it("reclaims abandoned claim temp directories", async () => {
    const root = await createRoot("bash-tools-cache-prune-claim-temps-");
    const now = 1_000_000;
    const directory = join(root, "flows", "flow-a", "project-command");
    mkdirSync(directory, { recursive: true });
    const abandoned = join(directory, `${"c".repeat(64)}.claim.1234.${"f".repeat(16)}.tmp`);
    mkdirSync(abandoned);
    writeFileSync(join(abandoned, "owner-def456.token"), "token", { encoding: "utf8" });
    const past = new Date(now - 60_000);
    utimesSync(abandoned, past, past);

    const summary = pruneEvidenceCaches({ rootDirectory: root, now: () => now });

    expect(summary.ownership).toBe("pruned");
    expect(summary.reclaimedStaleClaims).toBe(1);
    expect(existsSync(abandoned)).toBe(false);
  });

  it("removes empty flow directory trees and keeps non-empty ones", async () => {
    const root = await createRoot("bash-tools-cache-prune-empty-dirs-");
    const now = 1_000_000;
    createFlowRecord(root, "flow-gone", "expired.json", 10, 8 * 24 * 60 * 60 * 1_000, now);
    createFlowRecord(root, "flow-kept", "fresh.json", 10, 0, now);

    const summary = pruneEvidenceCaches({ rootDirectory: root, now: () => now });

    expect(summary.ownership).toBe("pruned");
    expect(summary.removedEmptyDirectories).toBe(2);
    expect(existsSync(join(root, "flows", "flow-gone"))).toBe(false);
    expect(existsSync(join(root, "flows", "flow-kept", "project-command", "fresh.json"))).toBe(
      true,
    );
  });

  it("tolerates a missing cache root and scope folders without family directories", async () => {
    const missing = pruneEvidenceCaches({
      rootDirectory: join(await createRoot("bash-tools-cache-prune-missing-"), "none"),
    });
    expect(missing.ownership).toBe("pruned");
    expect(missing.scannedDirectories).toBe(0);

    const root = await createRoot("bash-tools-cache-prune-loose-");
    mkdirSync(join(root, "flows", "flow-a"), { recursive: true });
    writeFileSync(join(root, "flows", "loose-file.txt"), "file", { encoding: "utf8" });

    const loose = pruneEvidenceCaches({ rootDirectory: root, now: () => 1_000 });
    expect(loose.ownership).toBe("pruned");
    expect(loose.scannedDirectories).toBe(0);
    expect(readdirSync(join(root, "flows"))).toContain("loose-file.txt");
  });
});
