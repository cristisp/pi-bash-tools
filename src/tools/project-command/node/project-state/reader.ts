import { realpath, readFile, stat, lstat } from "node:fs/promises";
import {
  defaultPackageManagerAvailability,
  detectPackageManagerDetailsImpl as detectPackageManagerDetails,
} from "../../package-manager/detection.ts";
import { supportsNodeDependencyListForManager } from "../../package-manager/detection.ts";
import { findPackageManagerExecutableImpl as findPackageManagerExecutable } from "../../package-manager/executable.ts";
import type { ProjectResolutionFileSystem } from "../../resolution.ts";
import type { NodeProjectResolutionOptions } from "../../node.ts";
import type {
  NodeFileSystem,
  NodeManifest,
  NodeProjectState,
  NodeProjectStateOptions,
} from "../types.ts";
import { readNodeLockfilesInternal, projectBinaryAvailableInternal } from "./discovery.ts";
import { hashNodeScriptsInternal, readNodeManifestInternal } from "./manifest.ts";
import { applicableNodeCommandsInternal } from "./summary.ts";

const nodeFileSystem: ProjectResolutionFileSystem = {
  readFile: (path, encoding) => readFile(path, encoding),
  realpath: async (path) => realpath(path),
  stat,
  lstat: async (path) => lstat(path),
};

function missingNodeProjectState(): NodeProjectState {
  return {
    manifest: null,
    lockfiles: [],
    fallowBinaryAvailable: false,
    detected: null,
    managerExecutable: undefined,
    scriptHash: null,
    info: Object.freeze({
      nodeVersion: process.version,
      manifestPresent: false,
      packageManager: null,
      scripts: Object.freeze([]),
      applicableCommands: Object.freeze(["node_project_info"]),
    }),
  };
}

async function readPresentNodeProjectState(
  projectPath: string,
  options: NodeProjectResolutionOptions,
  stateOptions: NodeProjectStateOptions,
  fileSystem: NodeFileSystem,
  manifest: NodeManifest,
): Promise<NodeProjectState> {
  const lockfiles = await readNodeLockfilesInternal(projectPath, fileSystem);
  const fallowBinaryAvailable = stateOptions.probeFallow
    ? await projectBinaryAvailableInternal(projectPath, fileSystem)
    : false;
  const detected = detectPackageManagerDetails(
    manifest.hasPackageManager
      ? { packageManager: manifest.packageManager, lockfiles }
      : { lockfiles },
    options.availability ?? defaultPackageManagerAvailability,
  );
  const managerExecutable = await findPackageManagerExecutable(detected.manager, {
    fileSystem,
    nodeExecutable: options.nodeExecutable,
    approvedDirectories: options.approvedPackageManagerDirectories,
  });
  const info = Object.freeze({
    nodeVersion: process.version,
    manifestPresent: true,
    packageManager: Object.freeze({
      manager: detected.manager,
      version: detected.version ?? null,
      source: detected.source,
      executableAvailable: managerExecutable !== undefined,
    }),
    scripts: Object.freeze(Object.keys(manifest.scripts).sort()),
    applicableCommands: applicableNodeCommandsInternal(
      manifest.scripts,
      fallowBinaryAvailable,
      managerExecutable !== undefined &&
        supportsNodeDependencyListForManager(detected.manager, detected.version),
    ),
  });
  return {
    manifest,
    lockfiles,
    fallowBinaryAvailable,
    detected,
    managerExecutable,
    scriptHash: hashNodeScriptsInternal(manifest.scripts),
    info,
  };
}

export async function readNodeProjectState(
  projectPath: string,
  options: NodeProjectResolutionOptions,
  stateOptions: NodeProjectStateOptions,
): Promise<NodeProjectState> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const manifest = await readNodeManifestInternal(
    projectPath,
    fileSystem,
    stateOptions.allowMissing,
  );
  if (manifest === null) return missingNodeProjectState();
  return readPresentNodeProjectState(projectPath, options, stateOptions, fileSystem, manifest);
}
