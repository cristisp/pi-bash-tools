import { createHash } from "node:crypto";
import { lstat, readFile, readlink, stat } from "node:fs/promises";
import { join } from "node:path";

import { hashCanonicalJson } from "../../observability/canonical-json.ts";
import type { NodeFileSystem } from "./node/types.ts";
import type { ProjectCommandRelevantInputs } from "./relevant-inputs.ts";
import { safeRelativePath as normalizeSafeRelativePath } from "./safe-relative-path.ts";

const PROJECT_COMMAND_STATE_SNAPSHOT_VERSION = 1 as const;

type ProjectCommandStateEntryType = "missing" | "file" | "directory" | "symlink" | "other";

export interface ProjectCommandStateSnapshotEntry {
  readonly path: string;
  readonly type: ProjectCommandStateEntryType;
  readonly size?: number;
  readonly mtimeMs?: number;
  readonly ctimeMs?: number;
  readonly mode?: number;
  readonly contentHash?: string;
  readonly symlinkTargetHash?: string;
}

export interface ProjectCommandStateSnapshot {
  readonly version: typeof PROJECT_COMMAND_STATE_SNAPSHOT_VERSION;
  readonly entries: readonly ProjectCommandStateSnapshotEntry[];
}

export type ProjectCommandStateSnapshotResult =
  | { readonly status: "complete"; readonly snapshot: ProjectCommandStateSnapshot }
  | { readonly status: "incomplete"; readonly reason: string };

export type ProjectCommandStateSnapshotter = (
  projectPath: string,
  inputs: ProjectCommandRelevantInputs,
) => Promise<ProjectCommandStateSnapshotResult>;

const defaultFileSystem: NodeFileSystem = {
  readFile: (path, encoding) => readFile(path, encoding),
  readFileBytes: async (path) => readFile(path),
  readlinkBytes: async (path) => readlink(path, { encoding: "buffer" }),
  stat,
  lstat,
};

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function metadata(
  stats: import("node:fs").Stats,
): Omit<ProjectCommandStateSnapshotEntry, "path" | "type" | "contentHash" | "symlinkTargetHash"> {
  return {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    mode: stats.mode,
  };
}

async function readLinkStats(
  fullPath: string,
  fileSystem: NodeFileSystem,
): Promise<import("node:fs").Stats | undefined> {
  const lstatFile = fileSystem.lstat;
  if (lstatFile === undefined) throw new Error("Symlink-aware state snapshots require lstat");
  try {
    return await lstatFile(fullPath);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function hashSymlinkTarget(fullPath: string, fileSystem: NodeFileSystem): Promise<string> {
  const readlinkBytes = fileSystem.readlinkBytes;
  if (readlinkBytes === undefined) {
    throw new Error("Symlink-aware state snapshots require readlink");
  }
  const target = await readlinkBytes(fullPath);
  if (!(target instanceof Uint8Array)) {
    throw new Error("Symlink target must be read as bytes");
  }
  return createHash("sha256").update(target).digest("hex");
}

function entryType(
  stats: import("node:fs").Stats,
  isSymlink: boolean,
): ProjectCommandStateEntryType {
  if (isSymlink) return "symlink";
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  return "other";
}

async function snapshotFileContent(
  fullPath: string,
  path: string,
  type: ProjectCommandStateEntryType,
  stats: import("node:fs").Stats,
  fileSystem: NodeFileSystem,
  symlinkTargetHash: string | undefined,
): Promise<ProjectCommandStateSnapshotEntry> {
  const targetMetadata = symlinkTargetHash === undefined ? {} : { symlinkTargetHash };
  if (type !== "file" && type !== "symlink") {
    return Object.freeze({ path, type, ...metadata(stats), ...targetMetadata });
  }
  const readFileBytes = fileSystem.readFileBytes;
  if (readFileBytes === undefined) {
    throw new Error("Raw-byte state snapshots require readFileBytes");
  }
  const source = await readFileBytes(fullPath);
  if (!(source instanceof Uint8Array)) {
    throw new Error("File content must be read as bytes");
  }
  const contentHash = createHash("sha256").update(source).digest("hex");
  return Object.freeze({ path, type, ...metadata(stats), ...targetMetadata, contentHash });
}

async function snapshotEntry(
  projectPath: string,
  path: string,
  fileSystem: NodeFileSystem,
): Promise<ProjectCommandStateSnapshotEntry> {
  const fullPath = join(projectPath, path);
  const linkStats = await readLinkStats(fullPath, fileSystem);
  if (linkStats === undefined) return Object.freeze({ path, type: "missing" });
  if (typeof linkStats.isSymbolicLink !== "function") {
    throw new Error("Symlink-aware state snapshots require symbolic-link metadata");
  }
  const isSymlink = linkStats.isSymbolicLink();
  const symlinkTargetHash = isSymlink ? await hashSymlinkTarget(fullPath, fileSystem) : undefined;
  const stats = isSymlink ? await fileSystem.stat(fullPath) : linkStats;
  return snapshotFileContent(
    fullPath,
    path,
    entryType(stats, isSymlink),
    stats,
    fileSystem,
    symlinkTargetHash,
  );
}

export async function snapshotProjectCommandRelevantInputs(
  projectPath: string,
  inputs: ProjectCommandRelevantInputs,
  fileSystem: NodeFileSystem = defaultFileSystem,
): Promise<ProjectCommandStateSnapshotResult> {
  const paths = inputs.files.map((file) => normalizeSafeRelativePath(file.path));
  const validPaths = paths.filter((path): path is string => path !== undefined);
  if (validPaths.length !== paths.length) {
    return { status: "incomplete", reason: "invalid-relevant-input-path" };
  }
  const canonicalPaths = [...new Set(validPaths)].sort(compareStrings);
  try {
    const entries = await Promise.all(
      canonicalPaths.map((path) => snapshotEntry(projectPath, path, fileSystem)),
    );
    return Object.freeze({
      status: "complete" as const,
      snapshot: Object.freeze({
        version: PROJECT_COMMAND_STATE_SNAPSHOT_VERSION,
        entries: Object.freeze(entries),
      }),
    });
  } catch {
    return { status: "incomplete", reason: "state-snapshot-failed" };
  }
}

export function projectCommandStateSnapshotDigest(snapshot: ProjectCommandStateSnapshot): string {
  return hashCanonicalJson({
    stateSnapshotVersion: snapshot.version,
    entries: snapshot.entries,
  });
}

export function equalProjectCommandStateSnapshots(
  left: ProjectCommandStateSnapshot,
  right: ProjectCommandStateSnapshot,
): boolean {
  if (left.version !== right.version || left.entries.length !== right.entries.length) {
    return false;
  }
  return left.entries.every((entry, index) => {
    const other = right.entries[index];
    return (
      other !== undefined &&
      entry.path === other.path &&
      entry.type === other.type &&
      entry.size === other.size &&
      entry.mtimeMs === other.mtimeMs &&
      entry.ctimeMs === other.ctimeMs &&
      entry.mode === other.mode &&
      entry.contentHash === other.contentHash &&
      entry.symlinkTargetHash === other.symlinkTargetHash
    );
  });
}
