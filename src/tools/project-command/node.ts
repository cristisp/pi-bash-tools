import {
  canonicalizeNodeScriptsInternal as canonicalizeNodeScriptsImpl,
  hashNodeScriptsInternal as hashNodeScriptsImpl,
  readNodeProjectInfoInternal as readNodeProjectInfoImpl,
} from "./node/project-state.ts";
import { resolveNodeProjectCommandInternal as resolveNodeProjectCommandImpl } from "./node/command-resolution.ts";
import type { ProjectCommandDefinition } from "./definitions.ts";
import type { DetectedPackageManager, PackageManager } from "./package-manager.ts";
import type { ResolvedProjectCommand } from "./resolution/types.ts";
import type { NodeFileSystem } from "./node/types.ts";

export interface NodePackageManagerInfo {
  readonly manager: PackageManager;
  readonly version: string | null;
  readonly source: DetectedPackageManager["source"];
  readonly executableAvailable: boolean;
}

export interface NodeProjectInfo {
  readonly nodeVersion: string;
  readonly manifestPresent: boolean;
  readonly packageManager: NodePackageManagerInfo | null;
  readonly scripts: readonly string[];
  readonly applicableCommands: readonly string[];
}

export interface NodeProjectResolutionOptions {
  readonly availability?: import("./package-manager.ts").PackageManagerAvailabilityInput;
  readonly fileSystem?: NodeFileSystem;
  readonly nodeExecutable?: string;
  readonly approvedPackageManagerDirectories?: readonly string[];
}

export function canonicalizeNodeScripts(scripts: Readonly<Record<string, string>>): string {
  return canonicalizeNodeScriptsImpl(scripts);
}

export function hashNodeScripts(scripts: Readonly<Record<string, string>>): string {
  return hashNodeScriptsImpl(scripts);
}

export function readNodeProjectInfo(
  projectPath: string,
  options: NodeProjectResolutionOptions = {},
): Promise<NodeProjectInfo> {
  return readNodeProjectInfoImpl(projectPath, options);
}

export function resolveNodeProjectCommand(
  definition: ProjectCommandDefinition,
  projectPath: string,
  parameters?: unknown,
  options: NodeProjectResolutionOptions = {},
): Promise<ResolvedProjectCommand> {
  return resolveNodeProjectCommandImpl(definition, projectPath, parameters, options);
}
