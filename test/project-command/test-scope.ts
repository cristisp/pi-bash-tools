import { rm } from "node:fs/promises";

export interface TestScope {
  readonly track: (directory: string) => string;
  readonly cleanup: () => Promise<void>;
}

export function createTestScope(): TestScope {
  const directories: string[] = [];
  return {
    track(directory) {
      directories.push(directory);
      return directory;
    },
    async cleanup() {
      await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
      );
    },
  };
}
