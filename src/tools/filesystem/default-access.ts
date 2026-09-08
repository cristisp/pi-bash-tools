import { relative, sep } from "node:path";

import { runGit, type GitExec } from "../git/execution.ts";
import { resolveRepository } from "../git/repository.ts";
import { isPathWithin } from "../path-containment.ts";

function repositoryRelativePath(root: string, path: string): string | undefined {
  if (!isPathWithin(root, path)) {
    return undefined;
  }
  return relative(root, path).split(sep).join("/") || undefined;
}

export async function isTrackedWorkspacePath(
  path: string,
  workspace: string,
  exec: GitExec,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (signal?.aborted || !isPathWithin(workspace, path)) {
    return false;
  }

  let repository;
  try {
    repository = await resolveRepository(exec, workspace, signal);
  } catch {
    return false;
  }
  const repositoryPath = repositoryRelativePath(repository.root, path);
  if (repositoryPath === undefined || signal?.aborted) {
    return false;
  }

  try {
    const result = await runGit(
      exec,
      ["ls-files", "--cached", "--full-name", "-z", "--", `:(literal)${repositoryPath}`],
      repository.root,
      signal,
      "check Git tracked file",
    );
    return result.stdout.split("\0").some((entry) => entry === repositoryPath);
  } catch {
    return false;
  }
}
