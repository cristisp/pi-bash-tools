import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
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

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
      const headResult = await runGit(
        exec,
        ["rev-parse", "HEAD"],
        projectPath,
        signal,
        "repository HEAD",
      );
      const statusResult = await runGit(
        exec,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        projectPath,
        signal,
        "repository status",
      );
      const repositoryIdentity = (await realpath(rootResult.stdout.trim())).trim();
      const head = headResult.stdout.trim();
      if (repositoryIdentity.length === 0 || head.length === 0) return undefined;
      return Object.freeze({
        repositoryIdentity,
        head,
        dirtyFilesDigest: digest(statusResult.stdout),
      });
    } catch {
      return undefined;
    }
  };
}
