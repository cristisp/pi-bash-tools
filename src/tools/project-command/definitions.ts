import { createHash } from "node:crypto";
import type { CommandIdentity } from "../policy/types.ts";

export const PROJECT_COMMAND_NAMESPACE = "bash-tools.project-command" as const;
const PROJECT_COMMAND_PROCESS_TIMEOUT_MS = 30_000;
export const PROJECT_COMMAND_OUTPUT_LIMIT_BYTES = 50 * 1024;

export interface ProjectCommandDefinition<CommandId extends string = string> {
  readonly namespace: typeof PROJECT_COMMAND_NAMESPACE;
  readonly commandId: CommandId;
  readonly description: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwdStrategy: "canonical-project";
  readonly sanitizedEnvironmentProfile: "minimal-static-v1";
  readonly processTimeoutMs: number;
  readonly outputLimitBytes: number;
  readonly risk: "workspace-observation" | "runtime-observation";
  readonly globalSafe: boolean;
}

function freezeDefinition<const Definition extends ProjectCommandDefinition>(
  definition: Definition,
): Readonly<Definition> {
  return Object.freeze({
    ...definition,
    args: Object.freeze([...definition.args]),
  });
}

const definitions = Object.freeze([
  freezeDefinition({
    namespace: PROJECT_COMMAND_NAMESPACE,
    commandId: "workspace_path",
    description:
      "Report the canonical project directory. Use when the user asks where the project workspace is located.",
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
    description:
      "Report the Node.js runtime version. Use when the user asks which Node.js version is active.",
    executable: process.execPath,
    args: ["--version"],
    cwdStrategy: "canonical-project",
    sanitizedEnvironmentProfile: "minimal-static-v1",
    processTimeoutMs: PROJECT_COMMAND_PROCESS_TIMEOUT_MS,
    outputLimitBytes: PROJECT_COMMAND_OUTPUT_LIMIT_BYTES,
    risk: "runtime-observation",
    globalSafe: true,
  }),
] as const);

export type ProjectCommandId = (typeof definitions)[number]["commandId"];
export type BuiltInProjectCommandDefinitions = typeof definitions;

const definitionsById = new Map<ProjectCommandId, (typeof definitions)[number]>(
  definitions.map((definition) => [definition.commandId, definition]),
);

function isProjectCommandId(commandId: string): commandId is ProjectCommandId {
  return definitions.some((definition) => definition.commandId === commandId);
}

interface ResolvedCommandLine {
  readonly executable: string;
  readonly args: readonly string[];
}

function commandLine(
  definition: ProjectCommandDefinition,
  resolvedExecutableOrCommand?: string | ResolvedCommandLine,
  resolvedArgs?: readonly string[],
): ResolvedCommandLine {
  if (typeof resolvedExecutableOrCommand === "object" && resolvedExecutableOrCommand !== null) {
    return resolvedExecutableOrCommand;
  }
  return {
    executable:
      typeof resolvedExecutableOrCommand === "string"
        ? resolvedExecutableOrCommand
        : definition.executable,
    args:
      typeof resolvedExecutableOrCommand === "string"
        ? (resolvedArgs ?? definition.args)
        : definition.args,
  };
}

function fingerprintPayload(
  definition: ProjectCommandDefinition,
  resolvedExecutableOrCommand?: string | ResolvedCommandLine,
  resolvedArgs?: readonly string[],
): string {
  const resolved = commandLine(definition, resolvedExecutableOrCommand, resolvedArgs);
  return JSON.stringify({
    namespace: definition.namespace,
    semanticId: definition.commandId,
    resolvedExecutable: resolved.executable,
    args: [...resolved.args],
    cwdStrategy: definition.cwdStrategy,
    sanitizedEnvironmentProfile: definition.sanitizedEnvironmentProfile,
    processTimeoutMs: definition.processTimeoutMs,
    outputLimitBytes: definition.outputLimitBytes,
    risk: definition.risk,
    globalSafe: definition.globalSafe,
  });
}

export function fingerprintProjectCommandDefinition(
  definition: ProjectCommandDefinition,
  resolvedExecutableOrCommand?: string | ResolvedCommandLine,
  resolvedArgs?: readonly string[],
): string {
  return createHash("sha256")
    .update(fingerprintPayload(definition, resolvedExecutableOrCommand, resolvedArgs), "utf8")
    .digest("hex");
}

export function projectCommandIdentity(definition: ProjectCommandDefinition): CommandIdentity;
export function projectCommandIdentity(
  definition: ProjectCommandDefinition,
  resolvedExecutableOrCommand?: string | ResolvedCommandLine,
  resolvedArgs?: readonly string[],
): CommandIdentity;
export function projectCommandIdentity(
  definition: ProjectCommandDefinition,
  resolvedExecutableOrCommand?: string | ResolvedCommandLine,
  resolvedArgs?: readonly string[],
): CommandIdentity {
  return {
    commandId: definition.commandId,
    fingerprint: fingerprintProjectCommandDefinition(
      definition,
      resolvedExecutableOrCommand,
      resolvedArgs,
    ),
  };
}

export function getProjectCommandDefinition(
  commandId: string,
): ProjectCommandDefinition | undefined {
  return isProjectCommandId(commandId) ? definitionsById.get(commandId) : undefined;
}

export function getProjectCommandDefinitions(): BuiltInProjectCommandDefinitions {
  return definitions;
}
