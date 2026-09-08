import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EnvironmentToolContext } from "../../src/tools/environment/environment-tool.ts";
import { createDirectoryTestFixtures } from "../directory-test-fixtures.ts";

export function createEnvironmentToolTestFixtures() {
  const directoryFixtures = createDirectoryTestFixtures();

  return {
    context(
      cwd: string,
      overrides: Partial<Pick<EnvironmentToolContext, "mode" | "hasUI" | "signal">> & {
        select?: EnvironmentToolContext["ui"]["select"];
      } = {},
    ): EnvironmentToolContext {
      return {
        cwd,
        mode: overrides.mode ?? "print",
        hasUI: overrides.hasUI ?? false,
        signal: overrides.signal,
        ui: { select: overrides.select ?? (async () => undefined) },
      };
    },
    async createPolicyFixture(
      global: { allow?: string[]; deny?: string[] } = {},
    ): Promise<{ directory: string; configPath: string }> {
      const directory = await mkdtemp(join(tmpdir(), "bash-tools-environment-"));
      directoryFixtures.trackDirectory(directory);
      const configPath = join(await realpath(directory), "bash-tools.json");
      await writeFile(configPath, JSON.stringify({ version: 1, global }));
      return { directory, configPath };
    },
    cleanup: directoryFixtures.cleanup,
  };
}
