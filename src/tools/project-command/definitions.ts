import { createHash } from "node:crypto";
import type { CommandIdentity } from "../policy/types.ts";
import { NODE_TEST_PARAMETERS, type ProjectCommandParameterDeclaration } from "./parameters.ts";

export const PROJECT_COMMAND_NAMESPACE = "bash-tools.project-command" as const;
const PROJECT_COMMAND_PROCESS_TIMEOUT_MS = 30_000;
export const PROJECT_COMMAND_OUTPUT_LIMIT_BYTES = 50 * 1024;

export type ProjectCommandExecutionKind = "process" | "in-process";
export type ProjectCommandApplicability = "always" | "node-script";
export type ProjectCommandRisk =
  | "workspace-observation"
  | "runtime-observation"
  | "observe"
  | "project-code";
export type ProjectCommandEnvironmentProfile = "minimal-static-v1" | "node-v1";
export type ProjectCommandTruncationDirection = "head" | "tail";

export interface ProjectCommandDefinition<CommandId extends string = string> {
  readonly namespace: typeof PROJECT_COMMAND_NAMESPACE;
  readonly commandId: CommandId;
  readonly description: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwdStrategy: "canonical-project";
  readonly sanitizedEnvironmentProfile: ProjectCommandEnvironmentProfile;
  readonly environmentProfile?: ProjectCommandEnvironmentProfile;
  readonly processTimeoutMs: number;
  readonly outputLimitBytes: number;
  readonly risk: ProjectCommandRisk;
  readonly globalSafe: boolean;
  readonly executionKind?: ProjectCommandExecutionKind;
  readonly applicability?: ProjectCommandApplicability;
  readonly bindsRepoContent?: boolean;
  readonly scriptBinding?: "none" | "package-script";
  readonly truncationDirection?: ProjectCommandTruncationDirection;
  readonly parameters?: readonly ProjectCommandParameterDeclaration[];
  readonly argvTemplate?: readonly string[];
  readonly fixedScriptKey?: "test" | "build" | "lint" | "typecheck";
}

function freezeDefinition<const Definition extends ProjectCommandDefinition>(
  definition: Definition,
): Readonly<Definition> {
  return Object.freeze({
    ...definition,
    args: Object.freeze([...definition.args]),
    parameters:
      definition.parameters === undefined
        ? undefined
        : Object.freeze(definition.parameters.map((parameter) => Object.freeze({ ...parameter }))),
    argvTemplate:
      definition.argvTemplate === undefined
        ? undefined
        : Object.freeze([...definition.argvTemplate]),
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
    environmentProfile: "minimal-static-v1",
    processTimeoutMs: PROJECT_COMMAND_PROCESS_TIMEOUT_MS,
    outputLimitBytes: PROJECT_COMMAND_OUTPUT_LIMIT_BYTES,
    risk: "workspace-observation",
    globalSafe: true,
    executionKind: "process",
    applicability: "always",
    bindsRepoContent: false,
    scriptBinding: "none",
    truncationDirection: "head",
    parameters: [],
    argvTemplate: [],
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
    environmentProfile: "minimal-static-v1",
    processTimeoutMs: PROJECT_COMMAND_PROCESS_TIMEOUT_MS,
    outputLimitBytes: PROJECT_COMMAND_OUTPUT_LIMIT_BYTES,
    risk: "runtime-observation",
    globalSafe: true,
    executionKind: "process",
    applicability: "always",
    bindsRepoContent: false,
    scriptBinding: "none",
    truncationDirection: "head",
    parameters: [],
    argvTemplate: ["--version"],
  }),
  freezeDefinition({
    namespace: PROJECT_COMMAND_NAMESPACE,
    commandId: "node_project_info",
    description:
      "Report the active Node.js project manifest, package manager, scripts, and applicable project commands.",
    executable: "in-process",
    args: [],
    cwdStrategy: "canonical-project",
    sanitizedEnvironmentProfile: "minimal-static-v1",
    environmentProfile: "minimal-static-v1",
    processTimeoutMs: PROJECT_COMMAND_PROCESS_TIMEOUT_MS,
    outputLimitBytes: PROJECT_COMMAND_OUTPUT_LIMIT_BYTES,
    risk: "observe",
    globalSafe: true,
    executionKind: "in-process",
    applicability: "always",
    bindsRepoContent: false,
    scriptBinding: "none",
    truncationDirection: "head",
    parameters: [],
    argvTemplate: ["node_project_info"],
  }),
  freezeDefinition({
    namespace: PROJECT_COMMAND_NAMESPACE,
    commandId: "node_test",
    description: "Run the exact package.json test script with optional workspace-relative paths.",
    executable: "",
    args: ["run", "test"],
    cwdStrategy: "canonical-project",
    sanitizedEnvironmentProfile: "node-v1",
    environmentProfile: "node-v1",
    processTimeoutMs: PROJECT_COMMAND_PROCESS_TIMEOUT_MS,
    outputLimitBytes: PROJECT_COMMAND_OUTPUT_LIMIT_BYTES,
    risk: "project-code",
    globalSafe: false,
    executionKind: "process",
    applicability: "node-script",
    bindsRepoContent: true,
    scriptBinding: "package-script",
    truncationDirection: "tail",
    parameters: NODE_TEST_PARAMETERS,
    argvTemplate: ["<package-manager>", "run", "test", "[--]", "<paths>"],
    fixedScriptKey: "test",
  }),
  freezeDefinition({
    namespace: PROJECT_COMMAND_NAMESPACE,
    commandId: "node_build",
    description: "Run the exact package.json build script.",
    executable: "",
    args: ["run", "build"],
    cwdStrategy: "canonical-project",
    sanitizedEnvironmentProfile: "node-v1",
    environmentProfile: "node-v1",
    processTimeoutMs: PROJECT_COMMAND_PROCESS_TIMEOUT_MS,
    outputLimitBytes: PROJECT_COMMAND_OUTPUT_LIMIT_BYTES,
    risk: "project-code",
    globalSafe: false,
    executionKind: "process",
    applicability: "node-script",
    bindsRepoContent: true,
    scriptBinding: "package-script",
    truncationDirection: "tail",
    parameters: [],
    argvTemplate: ["<package-manager>", "run", "build"],
    fixedScriptKey: "build",
  }),
  freezeDefinition({
    namespace: PROJECT_COMMAND_NAMESPACE,
    commandId: "node_lint",
    description: "Run the exact package.json lint script.",
    executable: "",
    args: ["run", "lint"],
    cwdStrategy: "canonical-project",
    sanitizedEnvironmentProfile: "node-v1",
    environmentProfile: "node-v1",
    processTimeoutMs: PROJECT_COMMAND_PROCESS_TIMEOUT_MS,
    outputLimitBytes: PROJECT_COMMAND_OUTPUT_LIMIT_BYTES,
    risk: "project-code",
    globalSafe: false,
    executionKind: "process",
    applicability: "node-script",
    bindsRepoContent: true,
    scriptBinding: "package-script",
    truncationDirection: "tail",
    parameters: [],
    argvTemplate: ["<package-manager>", "run", "lint"],
    fixedScriptKey: "lint",
  }),
  freezeDefinition({
    namespace: PROJECT_COMMAND_NAMESPACE,
    commandId: "node_typecheck",
    description: "Run the exact package.json typecheck script.",
    executable: "",
    args: ["run", "typecheck"],
    cwdStrategy: "canonical-project",
    sanitizedEnvironmentProfile: "node-v1",
    environmentProfile: "node-v1",
    processTimeoutMs: PROJECT_COMMAND_PROCESS_TIMEOUT_MS,
    outputLimitBytes: PROJECT_COMMAND_OUTPUT_LIMIT_BYTES,
    risk: "project-code",
    globalSafe: false,
    executionKind: "process",
    applicability: "node-script",
    bindsRepoContent: true,
    scriptBinding: "package-script",
    truncationDirection: "tail",
    parameters: [],
    argvTemplate: ["<package-manager>", "run", "typecheck"],
    fixedScriptKey: "typecheck",
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

export interface ResolvedCommandLine {
  readonly executable: string;
  readonly args: readonly string[];
  readonly fingerprintArgs?: readonly string[];
  readonly scriptHash?: string;
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

function isLegacyDefinition(definition: ProjectCommandDefinition): boolean {
  return definition.commandId === "workspace_path" || definition.commandId === "node_version";
}

function legacyFingerprintPayload(
  definition: ProjectCommandDefinition,
  resolved: ResolvedCommandLine,
): string {
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

function catalogCoreMetadata(
  definition: ProjectCommandDefinition,
): Readonly<Record<string, unknown>> {
  return {
    cwdStrategy: definition.cwdStrategy,
    sanitizedEnvironmentProfile: definition.sanitizedEnvironmentProfile,
    environmentProfile: definition.environmentProfile ?? definition.sanitizedEnvironmentProfile,
    processTimeoutMs: definition.processTimeoutMs,
    outputLimitBytes: definition.outputLimitBytes,
    risk: definition.risk,
    globalSafe: definition.globalSafe,
  };
}

function catalogExecutionMetadata(
  definition: ProjectCommandDefinition,
): Readonly<Record<string, unknown>> {
  return {
    executionKind: definition.executionKind ?? "process",
    applicability: definition.applicability ?? "always",
    bindsRepoContent: definition.bindsRepoContent ?? false,
    scriptBinding: definition.scriptBinding ?? "none",
    truncationDirection: definition.truncationDirection ?? "head",
  };
}

function catalogBindingMetadata(
  definition: ProjectCommandDefinition,
  resolved: ResolvedCommandLine,
): Readonly<Record<string, unknown>> {
  return {
    parameters: definition.parameters ?? [],
    fixedScriptKey: definition.fixedScriptKey ?? null,
    scriptHash: resolved.scriptHash ?? null,
  };
}

function catalogFingerprintMetadata(
  definition: ProjectCommandDefinition,
  resolved: ResolvedCommandLine,
): Readonly<Record<string, unknown>> {
  return {
    ...catalogCoreMetadata(definition),
    ...catalogExecutionMetadata(definition),
    ...catalogBindingMetadata(definition, resolved),
  };
}

function catalogFingerprintPayload(
  definition: ProjectCommandDefinition,
  resolved: ResolvedCommandLine,
): string {
  return JSON.stringify({
    namespace: definition.namespace,
    semanticId: definition.commandId,
    resolvedExecutable: resolved.executable,
    args: [...(resolved.fingerprintArgs ?? definition.argvTemplate ?? resolved.args)],
    ...catalogFingerprintMetadata(definition, resolved),
  });
}

function fingerprintPayload(
  definition: ProjectCommandDefinition,
  resolvedExecutableOrCommand?: string | ResolvedCommandLine,
  resolvedArgs?: readonly string[],
): string {
  const resolved = commandLine(definition, resolvedExecutableOrCommand, resolvedArgs);
  return isLegacyDefinition(definition)
    ? legacyFingerprintPayload(definition, resolved)
    : catalogFingerprintPayload(definition, resolved);
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
