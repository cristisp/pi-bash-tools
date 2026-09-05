import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { GitExec } from "../git/execution.ts";
import { runGit } from "../git/execution.ts";

export interface ProjectCommandRepositoryState {
  readonly repositoryIdentity: string;
  readonly head: string;
  readonly dirtyFilesDigest: string;
}

export type ProjectCommandRepositoryStateReader = (
  projectPath: string,
  signal: AbortSignal | undefined,
) => Promise<ProjectCommandRepositoryState | undefined>;

const MAX_REPOSITORY_STATE_BYTES = 2 * 1024 * 1024;
const MAX_REPOSITORY_STATE_PATHS = 4_096;
const MAX_REPOSITORY_STATE_PATH_BYTES = 128 * 1024;
const MAX_REPOSITORY_STATE_FILE_BYTES = 8 * 1024 * 1024;

function digest(parts: readonly string[]): string | undefined {
  const totalBytes = parts.reduce((total, part) => total + Buffer.byteLength(part, "utf8"), 0);
  if (totalBytes > MAX_REPOSITORY_STATE_BYTES) return undefined;
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part, "utf8").update("\0", "utf8");
  return hash.digest("hex");
}

function safeRelativePath(path: string): boolean {
  const normalized = path.split("\\").join("/");
  return !(
    normalized.length === 0 ||
    /^[A-Za-z]:\//u.test(normalized) ||
    isAbsolute(normalized) ||
    normalized
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  );
}

interface DirtyPath {
  readonly status: string;
  readonly path: string;
  readonly originalPath?: string;
}

type FileStat = Awaited<ReturnType<typeof lstat>>;

function sameFileState(left: FileStat, right: FileStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameIndexedFileState(left: FileStat | undefined, right: FileStat | undefined): boolean {
  return left !== undefined && right !== undefined && sameFileState(left, right);
}

function parseStatus(value: string): readonly DirtyPath[] | undefined {
  if (Buffer.byteLength(value, "utf8") > MAX_REPOSITORY_STATE_BYTES) return undefined;
  const records = value.split("\0").filter((record) => record.length > 0);
  const paths: DirtyPath[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4) return undefined;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (!safeRelativePath(path)) return undefined;
    const renameLike = status.includes("R") || status.includes("C");
    let originalPath: string | undefined;
    if (renameLike) {
      originalPath = records[index + 1];
      if (originalPath === undefined || !safeRelativePath(originalPath)) return undefined;
      index += 1;
    }
    paths.push({ status, path, ...(originalPath === undefined ? {} : { originalPath }) });
  }
  const pathBytes = paths.reduce(
    (total, entry) =>
      total +
      Buffer.byteLength(entry.path, "utf8") +
      (entry.originalPath === undefined ? 0 : Buffer.byteLength(entry.originalPath, "utf8")),
    0,
  );
  if (paths.length > MAX_REPOSITORY_STATE_PATHS || pathBytes > MAX_REPOSITORY_STATE_PATH_BYTES) {
    return undefined;
  }
  return paths;
}

async function contentDigest(
  repositoryRoot: string,
  status: string,
  exec: GitExec,
  projectPath: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const paths = parseStatus(status);
  if (paths === undefined) return undefined;
  const currentPaths = paths.map((entry) => entry.path);
  const stats = await Promise.all(
    currentPaths.map(async (path) => {
      try {
        return await lstat(join(repositoryRoot, path));
      } catch {
        return undefined;
      }
    }),
  );
  if (stats.some((entry) => entry === undefined)) return undefined;
  if (
    stats.some(
      (entry) =>
        entry !== undefined &&
        ((entry.isFile() && entry.size > MAX_REPOSITORY_STATE_FILE_BYTES) ||
          (!entry.isFile() && !entry.isSymbolicLink())),
    )
  ) {
    return undefined;
  }
  const hashResult =
    currentPaths.length === 0
      ? undefined
      : await runGit(
          exec,
          ["hash-object", "--", ...currentPaths],
          projectPath,
          signal,
          "dirty file content",
          MAX_REPOSITORY_STATE_BYTES,
        );
  if (
    hashResult !== undefined &&
    Buffer.byteLength(hashResult.stdout, "utf8") > MAX_REPOSITORY_STATE_BYTES
  ) {
    return undefined;
  }
  const hashes = hashResult?.stdout.split("\n").filter((hash) => hash.length > 0) ?? [];
  if (
    hashes.length !== currentPaths.length ||
    hashes.some((hash) => !/^[0-9a-f]{40,64}$/u.test(hash))
  ) {
    return currentPaths.length === 0 ? digest(["status", status]) : undefined;
  }
  const finalStats = await Promise.all(
    currentPaths.map(async (path) => {
      try {
        return await lstat(join(repositoryRoot, path));
      } catch {
        return undefined;
      }
    }),
  );
  if (finalStats.some((entry, index) => !sameIndexedFileState(stats[index], entry))) {
    return undefined;
  }
  return digest([
    "status",
    status,
    ...paths.flatMap((entry, index) => [
      "path",
      entry.status,
      entry.path,
      entry.originalPath ?? "",
      String(stats[index]?.mode ?? 0),
      String(stats[index]?.size ?? 0),
      hashes[index] ?? "",
    ]),
  ]);
}

export function createProjectCommandRepositoryStateReader(
  exec: GitExec,
): ProjectCommandRepositoryStateReader {
  return async (projectPath, signal) => {
    try {
      const rootResult = await runGit(
        exec,
        ["rev-parse", "--show-toplevel"],
        projectPath,
        signal,
        "repository root",
      );
      const repositoryIdentity = (await realpath(rootResult.stdout.trim())).trim();
      if (repositoryIdentity.length === 0) return undefined;
      const headResult = await runGit(
        exec,
        ["rev-parse", "HEAD"],
        repositoryIdentity,
        signal,
        "repository HEAD",
      );
      const statusResult = await runGit(
        exec,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        repositoryIdentity,
        signal,
        "repository status",
        MAX_REPOSITORY_STATE_BYTES,
      );
      const head = headResult.stdout.trim();
      if (head.length === 0) return undefined;
      const dirtyFilesDigest = await contentDigest(
        repositoryIdentity,
        statusResult.stdout,
        exec,
        repositoryIdentity,
        signal,
      );
      if (dirtyFilesDigest === undefined) return undefined;
      return Object.freeze({ repositoryIdentity, head, dirtyFilesDigest });
    } catch {
      return undefined;
    }
  };
}
