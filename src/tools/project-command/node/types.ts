import type { DetectedPackageManager } from "../package-manager.ts";
import type { ProjectResolutionFileSystem } from "../resolution.ts";
import type { NodeProjectInfo } from "../node.ts";

export type NodeFileSystem = Pick<ProjectResolutionFileSystem, "readFile" | "stat"> &
  Partial<Pick<ProjectResolutionFileSystem, "realpath" | "lstat">>;

export interface NodeManifest {
  readonly scripts: Readonly<Record<string, string>>;
  readonly packageManager: unknown;
  readonly hasPackageManager: boolean;
}

export interface NodeProjectState {
  readonly manifest: NodeManifest | null;
  readonly lockfiles: readonly string[];
  readonly fallowBinaryAvailable: boolean;
  readonly detected: DetectedPackageManager | null;
  readonly managerExecutable: string | undefined;
  readonly scriptHash: string | null;
  readonly info: NodeProjectInfo;
}

export interface NodeProjectStateOptions {
  readonly allowMissing: boolean;
  readonly probeFallow: boolean;
}
