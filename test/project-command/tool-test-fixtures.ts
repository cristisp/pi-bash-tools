import { realpath, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { ResolvedProjectCommand } from "../../src/tools/project-command/resolution/types.ts";
import type { ProjectCommandToolContext } from "../../src/tools/project-command/tool.ts";

const directories: string[] = [];

export async function cleanupProjectCommandFixtures(): Promise<void> {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
}

export function context(
  cwd: string,
  overrides: Partial<ProjectCommandToolContext> = {},
): ProjectCommandToolContext {
  return {
    cwd,
    mode: "print",
    hasUI: false,
    signal: undefined,
    ui: { select: async () => undefined },
    ...overrides,
  };
}

export async function fixture(
  value: unknown = { version: 1 },
): Promise<{ directory: string; configPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "bash-tools-project-command-tool-"));
  directories.push(directory);
  const configPath = join(await realpath(directory), "bash-tools.json");
  await writeFile(configPath, JSON.stringify(value));
  return { directory, configPath };
}

export function successExecutor() {
  return vi.fn(async (_resolved: ResolvedProjectCommand, cwd: string) => ({
    status: "success" as const,
    exit: { code: 0, signal: null },
    timedOut: false,
    cancelled: false,
    stdout: { text: cwd, truncated: false, totalBytes: cwd.length, totalLines: 1 },
    stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
  }));
}
