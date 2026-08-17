import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDirectoryTestFixtures } from "../../../../test/directory-test-fixtures.ts";

export function createPolicyTestFixtures() {
  const directoryFixtures = createDirectoryTestFixtures();

  return {
    async createDirectory(): Promise<string> {
      const directory = await mkdtemp(join(tmpdir(), "bash-tools-environment-policy-"));
      directoryFixtures.trackDirectory(directory);
      return directory;
    },
    trackDirectory: directoryFixtures.trackDirectory,
    cleanup: directoryFixtures.cleanup,
  };
}
