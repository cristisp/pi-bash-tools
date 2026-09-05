import { dirname } from "node:path";
import { displayPath } from "../path-display.ts";

export const PROJECT_COMMAND_MAX_NEAREST_PATHS = 4;
export const PROJECT_COMMAND_MAX_NEAREST_PATH_LENGTH = 512;

export interface ResolutionPathFileSystem {
  readonly realpath: (path: string) => Promise<string>;
}

function boundedPath(path: string): string {
  const displayed = displayPath(path);
  return displayed.length <= PROJECT_COMMAND_MAX_NEAREST_PATH_LENGTH
    ? displayed
    : `${displayed.slice(0, PROJECT_COMMAND_MAX_NEAREST_PATH_LENGTH - 1)}…`;
}

export async function nearestExistingPaths(
  requestedPath: string,
  fileSystem: ResolutionPathFileSystem,
  limit = PROJECT_COMMAND_MAX_NEAREST_PATHS,
): Promise<readonly string[]> {
  const boundedLimit = Number.isFinite(limit)
    ? Math.max(0, Math.min(Math.floor(limit), PROJECT_COMMAND_MAX_NEAREST_PATHS))
    : 0;
  const candidates: string[] = [];
  let candidate = requestedPath;
  while (candidates.length < boundedLimit) {
    candidates.push(candidate);
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  const resolved = await Promise.all(
    candidates.map(async (path) => {
      try {
        return boundedPath(await fileSystem.realpath(path));
      } catch {
        return undefined;
      }
    }),
  );
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const existing of resolved) {
    if (existing !== undefined && !seen.has(existing)) {
      seen.add(existing);
      paths.push(existing);
    }
  }
  return Object.freeze(paths);
}

export function withNearestExistingPaths(
  details: Readonly<Record<string, string | number | boolean | null | readonly string[]>>,
  paths: readonly string[],
): Readonly<Record<string, string | number | boolean | null | readonly string[]>> {
  return paths.length === 0 ? details : { ...details, nearestExistingPaths: paths };
}
