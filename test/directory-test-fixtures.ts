import { rm } from "node:fs/promises";

export function createDirectoryTestFixtures() {
  const directories: string[] = [];

  return {
    trackDirectory: (directory: string): void => {
      directories.push(directory);
    },
    cleanup: async (): Promise<void> => {
      await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
      );
    },
  };
}
