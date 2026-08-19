import { createHash } from "node:crypto";
import type { CommandIdentity } from "../policy/types.ts";

export const PROJECT_COMMAND_NAMESPACE = "bash-tools.project-command" as const;
const PROJECT_COMMAND_PROCESS_TIMEOUT_MS = 30_000;
export const PROJECT_COMMAND_OUTPUT_LIMIT_BYTES = 50 * 1024;

export type ProjectCommandId = "workspace_path" | "node_version";

export interface ProjectCommandDefinition {
  readonly namespace: typeof PROJECT_COMMAND_NAMESPACE;
  readonly commandId: ProjectCommandId;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwdStrategy: "canonical-project";
  readonly sanitizedEnvironmentProfile: "minimal-static-v1";
  readonly processTimeoutMs: number;
  readonly outputLimitBytes: number;
  readonly risk: "workspace-observation" | "runtime-observation";
  readonly globalSafe: boolean;
}

function freezeDefinition(definition: ProjectCommandDefinition): ProjectCommandDefinition {
  return Object.freeze({ ...definition, args: Object.freeze([...definition.args]) });
}

const definitions: readonly ProjectCommandDefinition[] = Object.freeze([
  freezeDefinition({
    namespace: PROJECT_COMMAND_NAMESPACE,
    commandId: "workspace_path",
    executable: "/bin/pwd",
    args: [],
    cwdStrategy: "canonical-project",
    sanitizedEnvironmentProfile: "minimal-static-v1",
    processTimeoutMs: PROJECT_COMMAND_PROCESS_TIMEOUT_MS,
    outputLimitBytes: PROJECT_COMMAND_OUTPUT_LIMIT_BYTES,
    risk: "workspace-observation",
    globalSafe: true,
  }),
  freezeDefinition({
    namespace: PROJECT_COMMAND_NAMESPACE,
    commandId: "node_version",
    executable: process.execPath,
    args: ["--version"],
    cwdStrategy: "canonical-project",
    sanitizedEnvironmentProfile: "minimal-static-v1",
    processTimeoutMs: PROJECT_COMMAND_PROCESS_TIMEOUT_MS,
    outputLimitBytes: PROJECT_COMMAND_OUTPUT_LIMIT_BYTES,
    risk: "runtime-observation",
    globalSafe: true,
  }),
]);

const definitionsById = new Map<string, ProjectCommandDefinition>(
  definitions.map((definition) => [definition.commandId, definition]),
);

function fingerprintPayload(definition: ProjectCommandDefinition): string {
  return JSON.stringify({
    namespace: definition.namespace,
    semanticId: definition.commandId,
    resolvedExecutable: definition.executable,
    args: [...definition.args],
    cwdStrategy: definition.cwdStrategy,
    sanitizedEnvironmentProfile: definition.sanitizedEnvironmentProfile,
    processTimeoutMs: definition.processTimeoutMs,
    outputLimitBytes: definition.outputLimitBytes,
    risk: definition.risk,
    globalSafe: definition.globalSafe,
  });
}

export function fingerprintProjectCommandDefinition(definition: ProjectCommandDefinition): string {
  return createHash("sha256").update(fingerprintPayload(definition), "utf8").digest("hex");
}

export function projectCommandIdentity(definition: ProjectCommandDefinition): CommandIdentity {
  return {
    commandId: definition.commandId,
    fingerprint: fingerprintProjectCommandDefinition(definition),
  };
}

export function getProjectCommandDefinition(
  commandId: string,
): ProjectCommandDefinition | undefined {
  return definitionsById.get(commandId);
}

export function getProjectCommandDefinitions(): readonly ProjectCommandDefinition[] {
  return definitions;
}
