import type { ProjectCommandDefinition } from "./definitions.ts";

export const PROJECT_COMMAND_MAX_RELEVANT_INPUT_CONFIG_PATHS = 32;
export const PROJECT_COMMAND_MAX_RELEVANT_INPUT_PATH_LENGTH = 256;

export interface ProjectCommandRelevantInputFile {
  readonly kind: "file";
  readonly path: string;
}

export interface ProjectCommandRelevantInputValue {
  readonly kind: "value";
  readonly name: string;
  readonly value: string;
}

export interface ProjectCommandRelevantInputs {
  readonly files: readonly ProjectCommandRelevantInputFile[];
  readonly values: readonly ProjectCommandRelevantInputValue[];
}

export interface ProjectCommandRelevantInputCommandRequest {
  readonly kind?: "project-command";
  readonly definition: ProjectCommandDefinition;
  readonly projectPath: string;
  readonly parameters?: unknown;
}

export interface ProjectCommandRelevantInputWorkspaceSnapshotRequest {
  readonly kind: "workspace-snapshot";
  readonly definition: ProjectCommandDefinition;
  readonly projectPath: string;
  readonly parameters?: unknown;
}

export type ProjectCommandRelevantInputDiscoveryRequest =
  | ProjectCommandRelevantInputCommandRequest
  | ProjectCommandRelevantInputWorkspaceSnapshotRequest;

export interface ProjectCommandRelevantInputDiscoveryComplete {
  readonly status: "complete";
  readonly inputs: ProjectCommandRelevantInputs;
}

export interface ProjectCommandRelevantInputDiscoveryIncomplete {
  readonly status: "incomplete";
  readonly reason: string;
}

export interface ProjectCommandRelevantInputDiscoveryError {
  readonly status: "error";
  readonly error: unknown;
}

export type ProjectCommandRelevantInputDiscoveryResult =
  | ProjectCommandRelevantInputDiscoveryComplete
  | ProjectCommandRelevantInputDiscoveryIncomplete
  | ProjectCommandRelevantInputDiscoveryError;

export type ProjectCommandRelevantInputDiscoverer = (
  request: ProjectCommandRelevantInputDiscoveryRequest,
  signal?: AbortSignal,
) => Promise<ProjectCommandRelevantInputDiscoveryResult>;

export interface ProjectCommandRelevantInputDiscovery {
  readonly discover: ProjectCommandRelevantInputDiscoverer;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalProjectCommandRelevantInputs(
  files: readonly ProjectCommandRelevantInputFile[] = [],
  values: readonly ProjectCommandRelevantInputValue[] = [],
): ProjectCommandRelevantInputs {
  const canonicalFiles = [
    ...new Map(
      files.map((file) => {
        const path = file.path.split("\\").join("/");
        return [path, Object.freeze({ kind: "file" as const, path })] as const;
      }),
    ).values(),
  ].sort((left, right) => compareStrings(left.path, right.path));
  const canonicalValues = [
    ...new Map(
      values.map((value) => [
        JSON.stringify([value.name, value.value]),
        Object.freeze({ kind: "value" as const, name: value.name, value: value.value }),
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      compareStrings(left.name, right.name) || compareStrings(left.value, right.value),
  );
  return Object.freeze({
    files: Object.freeze(canonicalFiles),
    values: Object.freeze(canonicalValues),
  });
}
