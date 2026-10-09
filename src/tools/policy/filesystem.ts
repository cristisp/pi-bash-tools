import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open as openFileHandle,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";

import { policyError } from "./format.ts";

export interface PolicyFileStats {
  readonly dev: number;
  readonly ino: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface PolicyFileHandle {
  readonly fd: number;
  readFile(): Promise<string>;
  stat(): Promise<PolicyFileStats>;
  close(): Promise<void>;
}

export interface PolicyFileSystem {
  lstat(path: string): Promise<PolicyFileStats>;
  open(path: string, flags: number): Promise<PolicyFileHandle>;
  mkdir(
    path: string,
    options: { readonly recursive: boolean; readonly mode: number },
  ): Promise<void>;
  writeFile(
    path: string,
    data: string,
    options: { readonly encoding: "utf8"; readonly flag: "wx"; readonly mode: number },
  ): Promise<void>;
  readdir(path: string): Promise<readonly string[]>;
  rename(source: string, destination: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  realpath(path: string): Promise<string>;
}

export function createNodePolicyFileSystem(): PolicyFileSystem {
  return {
    lstat: (path) => lstat(path),
    open: async (path, flags) => {
      const handle = await openFileHandle(path, flags);
      return {
        fd: handle.fd,
        readFile: () => handle.readFile({ encoding: "utf8" }),
        stat: () => handle.stat(),
        close: async () => {
          await handle.close();
        },
      };
    },
    mkdir: async (path, options) => {
      await mkdir(path, options);
    },
    writeFile: async (path, data, options) => {
      await writeFile(path, data, options);
    },
    readdir: async (path) => [...(await readdir(path))],
    rename: (source, destination) => rename(source, destination),
    rmdir: (path) => rmdir(path),
    unlink: (path) => unlink(path),
    chmod: (path, mode) => chmod(path, mode),
    realpath: (path) => realpath(path),
  };
}

export function getPolicyDirectoryOpenFlags(): number {
  const directory = constants.O_DIRECTORY;
  const noFollow = constants.O_NOFOLLOW;
  const nonBlocking = constants.O_NONBLOCK;
  if (
    typeof directory !== "number" ||
    typeof noFollow !== "number" ||
    typeof nonBlocking !== "number"
  ) {
    throw policyError();
  }
  return constants.O_RDONLY | directory | noFollow | nonBlocking;
}

export function getPolicyReadOpenFlags(): number {
  const noFollow = constants.O_NOFOLLOW;
  const nonBlocking = constants.O_NONBLOCK;
  if (typeof noFollow !== "number" || typeof nonBlocking !== "number") {
    throw policyError();
  }
  return constants.O_RDONLY | noFollow | nonBlocking;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isMissingPolicyFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export function isPolicyFileAlreadyExistsError(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

export function isUnsupportedPolicyChmodError(error: unknown): boolean {
  return (
    isRecord(error) &&
    (error.code === "ENOSYS" || error.code === "ENOTSUP" || error.code === "EOPNOTSUPP")
  );
}
