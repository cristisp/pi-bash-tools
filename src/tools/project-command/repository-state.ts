import { realpath } from "node:fs/promises";

import type { GitExec } from "../git/execution.ts";
import { runGit } from "../git/execution.ts";
import { MAX_REPOSITORY_STATE_BYTES, contentDigest } from "./repository-state/dirty-files.ts";
import type { ProjectCommandRepositoryStateReader } from "./repository-state/types.ts";

export type {
  ProjectCommandRepositoryState,
  ProjectCommandRepositoryStateReader,
} from "./repository-state/types.ts";

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
