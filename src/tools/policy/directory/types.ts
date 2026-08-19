import type { PolicyFileHandle, PolicyFileSystem, PolicyFileStats } from "../filesystem.ts";

export interface SecureDirectory {
  readonly path: string;
  readonly handles: readonly PolicyFileHandle[];
  readonly closeCwd?: () => Promise<void>;
}

export interface OpenedPolicyDirectory {
  readonly path: string;
  readonly handle: PolicyFileHandle;
  readonly stats: PolicyFileStats;
}

export interface PolicyDirectoryOperations {
  readonly closeHandle: (handle: PolicyFileHandle | undefined) => Promise<void>;
  readonly closeDirectory: (directory: SecureDirectory) => Promise<void>;
  readonly openDirectory: (
    path: string,
    fileSystem: PolicyFileSystem,
  ) => Promise<OpenedPolicyDirectory>;
}
