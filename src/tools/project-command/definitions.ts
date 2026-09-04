import { createHash } from "node:crypto";
import type { CommandIdentity } from "../policy/types.ts";
import {
  FALLOW_AUDIT_PARAMETERS,
  NODE_TEST_PARAMETERS,
  type ProjectCommandParameterDeclaration,
} from "./parameters.ts";

export const PROJECT_COMMAND_NAMESPACE = "bash-tools.project-command" as const;
const PROJECT_COMMAND_PROCESS_TIMEOUT_MS = 30_000;
export const PROJECT_COMMAND_OUTPUT_LIMIT_BYTES = 50 * 1024;

export type ProjectCommandExecutionKind = "process" | "in-process";
export type ProjectCommandApplicability =
  | "always"
  | "node-script"
  | "node-dependency-list"
  | "fallow-binary";
export type ProjectCommandRisk =
  | "workspace-observation"
  | "runtime-observation"
  | "observe"
  | "project-code";
export type ProjectCommandEnvironmentProfile = "minimal-static-v1" | "node-v1";
export type ProjectCommandTruncationDirection = "head" | "tail";
export type ProjectCommandReusePolicy =
  | "never"
  | "static"
  | "project-metadata"
  | "workspace-snapshot";
export type ProjectCommandReusePolicyInput = ProjectCommandReusePolicy | (string & {});

const UNCONTROLLED_EXTERNAL_STATE_PROJECT_COMMAND_IDS = new Set([
  "node_project_info",
  "node_deps_list",
  "node_test",
  "node_build",
  "node_lint",
  "node_typecheck",
  "node_format",
  "fallow_dead_code",
  "fallow_dupes",
  "fallow_health",
  "fallow_audit",
  "fallow_list_entry_points",
  "fallow_list_boundaries",
]);

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
  readonly reusePolicy?: ProjectCommandReusePolicyInput;
  readonly mutatesWorkspace?: boolean;
  readonly uncontrolledExternalState?: boolean;
  readonly workspaceSnapshotApproved?: boolean;
  readonly relevantInputConfigPaths?: readonly string[];
  readonly executionKind?: ProjectCommandExecutionKind;
  readonly applicability?: ProjectCommandApplicability;
  readonly bindsRepoContent?: boolean;
  readonly scriptBinding?: "none" | "package-script";
  readonly binaryName?: "fallow";
  readonly acceptedExitCodes?: readonly number[];
  readonly truncationDirection?: ProjectCommandTruncationDirection;
  readonly parameters?: readonly ProjectCommandParameterDeclaration[];
  readonly argvTemplate?: readonly string[];
  readonly fixedScriptKey?: string;
  readonly scriptVariantFamily?: "test" | "lint" | "format";
  /** When true, the base package script is reserved and a validated variant is required. */
  readonly requiresVariant?: boolean;
}

function freezeDefinition<const Definition extends ProjectCommandDefinition>(
  definition: Definition,
): Readonly<Definition> {
  return Object.freeze({
    ...definition,
    args: Object.freeze([...definition.args]),
    ...(definition.acceptedExitCodes === undefined
      ? {}
      : { acceptedExitCodes: Object.freeze([...definition.acceptedExitCodes]) }),
    parameters:
      definition.parameters === undefined
        ? undefined
        : Object.freeze(definition.parameters.map((parameter) => Object.freeze({ ...parameter }))),
    argvTemplate:
      definition.argvTemplate === undefined
        ? undefined
        : Object.freeze([...definition.argvTemplate]),
    relevantInputConfigPaths:
      definition.relevantInputConfigPaths === undefined
        ? undefined
        : Object.freeze([...definition.relevantInputConfigPaths]),
  });
}

const definitions = Object.freeze([
  freezeDefinition({
    namespace: PROJECT_COMMAND_NAMESPACE,
    commandId: "workspace_path",
    reusePolicy: "static",
    uncontrolledExternalState: false,
    workspaceSnapshotApproved: false,
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
    reusePolicy: "static",
    uncontrolledExternalState: false,
    workspaceSnapshotApproved: false,
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
    reusePolicy: "never",
    uncontrolledExternalState: true,
    workspaceSnapshotApproved: false,
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
    commandId: "node_deps_list",
    reusePolicy: "never",
    uncontrolledExternalState: true,
    workspaceSnapshotApproved: false,
    description:
      "List the top-level Node project dependencies through the detected package manager without changing the project.",
    executable: "",
    args: [],
    cwdStrategy: "canonical-project",
    sanitizedEnvironmentProfile: "node-v1",
    environmentProfile: "node-v1",
    processTimeoutMs: PROJECT_COMMAND_PROCESS_TIMEOUT_MS,
    outputLimitBytes: PROJECT_COMMAND_OUTPUT_LIMIT_BYTES,
    risk: "observe",
    globalSafe: true,
    executionKind: "process",
    applicability: "node-dependency-list",
    bindsRepoContent: false,
    scriptBinding: "none",
    acceptedExitCodes: [1],
    truncationDirection: "head",
    parameters: [],
    argvTemplate: ["<package-manager>", "<fixed-list-args>"],
  }),
  freezeDefinition({
    namespace: PROJECT_COMMAND_NAMESPACE,
    commandId: "node_test",
    reusePolicy: "never",
    uncontrolledExternalState: true,
    workspaceSnapshotApproved: false,
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
    scriptVariantFamily: "test",
  }),
  freezeDefinition({
    namespace: PROJECT_COMMAND_NAMESPACE,
    commandId: "node_build",
    reusePolicy: "never",
    uncontrolledExternalState: true,
    workspaceSnapshotApproved: false,
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
    reusePolicy: "never",
    uncontrolledExternalState: true,
    workspaceSnapshotApproved: false,
    description:
      "Run the exact package.json lint script or an existing validated lint:<variant> script.",
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
    parameters: [
      {
        name: "variant",
        kind: "script-variant",
        required: false,
        mapping: "package-script-suffix",
      },
    ],
    argvTemplate: ["<package-manager>", "run", "lint"],
    fixedScriptKey: "lint",
    scriptVariantFamily: "lint",
  }),
  freezeDefinition({
    namespace: PROJECT_COMMAND_NAMESPACE,
    commandId: "node_typecheck",
    reusePolicy: "never",
    uncontrolledExternalState: true,
    workspaceSnapshotApproved: false,
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
  freezeDefinition({
    namespace: PROJECT_COMMAND_NAMESPACE,
    commandId: "node_format",
    reusePolicy: "never",
    mutatesWorkspace: true,
    uncontrolledExternalState: true,
    workspaceSnapshotApproved: false,
    description:
      "Run the exact package.json format script or an existing validated format:<variant> script.",
    executable: "",
    args: ["run", "format"],
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
    parameters: [
      {
        name: "variant",
        kind: "script-variant",
        required: false,
        mapping: "package-script-suffix",
      },
    ],
    argvTemplate: ["<package-manager>", "run", "format:<variant>"],
    fixedScriptKey: "format",
    scriptVariantFamily: "format",
  }),
  freezeDefinition({
    namespace: PROJECT_COMMAND_NAMESPACE,
    commandId: "fallow_dead_code",
    reusePolicy: "never",
    uncontrolledExternalState: true,
    workspaceSnapshotApproved: false,
    description: "Run Fallow dead-code analysis with machine-readable output.",
    executable: process.execPath,
    args: ["dead-code", "--format", "json", "--quiet"],
    cwdStrategy: "canonical-project",
    sanitizedEnvironmentProfile: "node-v1",
    environmentProfile: "node-v1",
    processTimeoutMs: PROJECT_COMMAND_PROCESS_TIMEOUT_MS,
    outputLimitBytes: PROJECT_COMMAND_OUTPUT_LIMIT_BYTES,
    risk: "project-code",
    globalSafe: false,
    executionKind: "process",
    applicability: "fallow-binary",
    bindsRepoContent: false,
    scriptBinding: "none",
    binaryName: "fallow",
    acceptedExitCodes: [1],
    truncationDirection: "tail",
    parameters: [],
    argvTemplate: ["<fallow-launcher>", "dead-code", "--format", "json", "--quiet"],
  }),
  freezeDefinition({
    namespace: PROJECT_COMMAND_NAMESPACE,
    commandId: "fallow_dupes",
    reusePolicy: "never",
    uncontrolledExternalState: true,
    workspaceSnapshotApproved: false,
    description: "Run Fallow duplicate-code analysis with machine-readable output.",
    executable: process.execPath,
    args: ["dupes", "--format", "json", "--quiet"],
    cwdStrategy: "canonical-project",
    sanitizedEnvironmentProfile: "node-v1",
    environmentProfile: "node-v1",
    processTimeoutMs: PROJECT_COMMAND_PROCESS_TIMEOUT_MS,
    outputLimitBytes: PROJECT_COMMAND_OUTPUT_LIMIT_BYTES,
    risk: "project-code",
    globalSafe: false,
    executionKind: "process",
    applicability: "fallow-binary",
    bindsRepoContent: false,
    scriptBinding: "none",
    binaryName: "fallow",
    acceptedExitCodes: [1],
    truncationDirection: "tail",
    parameters: [],
    argvTemplate: ["<fallow-launcher>", "dupes", "--format", "json", "--quiet"],
  }),
  freezeDefinition({
    namespace: PROJECT_COMMAND_NAMESPACE,
    commandId: "fallow_health",
    reusePolicy: "never",
    uncontrolledExternalState: true,
    workspaceSnapshotApproved: false,
    description: "Run Fallow project health analysis with machine-readable output.",
    executable: process.execPath,
    args: ["health", "--format", "json", "--quiet"],
    cwdStrategy: "canonical-project",
    sanitizedEnvironmentProfile: "node-v1",
    environmentProfile: "node-v1",
    processTimeoutMs: PROJECT_COMMAND_PROCESS_TIMEOUT_MS,
    outputLimitBytes: PROJECT_COMMAND_OUTPUT_LIMIT_BYTES,
    risk: "project-code",
    globalSafe: false,
    executionKind: "process",
    applicability: "fallow-binary",
    bindsRepoContent: false,
    scriptBinding: "none",
    binaryName: "fallow",
    acceptedExitCodes: [1],
    truncationDirection: "tail",
    parameters: [],
    argvTemplate: ["<fallow-launcher>", "health", "--format", "json", "--quiet"],
  }),
  freezeDefinition({
    namespace: PROJECT_COMMAND_NAMESPACE,
    commandId: "fallow_audit",
    reusePolicy: "never",
    uncontrolledExternalState: true,
    workspaceSnapshotApproved: false,
    description: "Run Fallow audit analysis against a specified base revision.",
    executable: process.execPath,
    args: ["audit", "--format", "json", "--quiet"],
    cwdStrategy: "canonical-project",
    sanitizedEnvironmentProfile: "node-v1",
    environmentProfile: "node-v1",
    processTimeoutMs: PROJECT_COMMAND_PROCESS_TIMEOUT_MS,
    outputLimitBytes: PROJECT_COMMAND_OUTPUT_LIMIT_BYTES,
    risk: "project-code",
    globalSafe: false,
    executionKind: "process",
    applicability: "fallow-binary",
    bindsRepoContent: false,
    scriptBinding: "none",
    binaryName: "fallow",
    acceptedExitCodes: [1],
    truncationDirection: "tail",
    parameters: FALLOW_AUDIT_PARAMETERS,
    argvTemplate: ["<fallow-launcher>", "audit", "--format", "json", "--quiet"],
  }),
  freezeDefinition({
    namespace: PROJECT_COMMAND_NAMESPACE,
    commandId: "fallow_list_entry_points",
    reusePolicy: "never",
    uncontrolledExternalState: true,
    workspaceSnapshotApproved: false,
    description: "List Fallow entry points with machine-readable output.",
    executable: process.execPath,
    args: ["list", "--entry-points", "--format", "json", "--quiet"],
    cwdStrategy: "canonical-project",
    sanitizedEnvironmentProfile: "node-v1",
    environmentProfile: "node-v1",
    processTimeoutMs: PROJECT_COMMAND_PROCESS_TIMEOUT_MS,
    outputLimitBytes: PROJECT_COMMAND_OUTPUT_LIMIT_BYTES,
    risk: "project-code",
    globalSafe: false,
    executionKind: "process",
    applicability: "fallow-binary",
    bindsRepoContent: false,
    scriptBinding: "none",
    binaryName: "fallow",
    acceptedExitCodes: [1],
    truncationDirection: "tail",
    parameters: [],
    argvTemplate: ["<fallow-launcher>", "list", "--entry-points", "--format", "json", "--quiet"],
  }),
  freezeDefinition({
    namespace: PROJECT_COMMAND_NAMESPACE,
    commandId: "fallow_list_boundaries",
    reusePolicy: "never",
    uncontrolledExternalState: true,
    workspaceSnapshotApproved: false,
    description: "List Fallow project boundaries with machine-readable output.",
    executable: process.execPath,
    args: ["list", "--boundaries", "--format", "json", "--quiet"],
    cwdStrategy: "canonical-project",
    sanitizedEnvironmentProfile: "node-v1",
    environmentProfile: "node-v1",
    processTimeoutMs: PROJECT_COMMAND_PROCESS_TIMEOUT_MS,
    outputLimitBytes: PROJECT_COMMAND_OUTPUT_LIMIT_BYTES,
    risk: "project-code",
    globalSafe: false,
    executionKind: "process",
    applicability: "fallow-binary",
    bindsRepoContent: false,
    scriptBinding: "none",
    binaryName: "fallow",
    acceptedExitCodes: [1],
    truncationDirection: "tail",
    parameters: [],
    argvTemplate: ["<fallow-launcher>", "list", "--boundaries", "--format", "json", "--quiet"],
  }),
] as const);

export type ProjectCommandId = (typeof definitions)[number]["commandId"];
export type BuiltInProjectCommandDefinitions = typeof definitions;

const definitionsById = new Map<ProjectCommandId, (typeof definitions)[number]>(
  definitions.map((definition) => [definition.commandId, definition]),
);

export function normalizeProjectCommandReusePolicy(value: unknown): ProjectCommandReusePolicy {
  switch (value) {
    case "static":
    case "project-metadata":
    case "workspace-snapshot":
    case "never":
      return value;
    default:
      return "never";
  }
}

function projectCommandMutatesWorkspace(definition: ProjectCommandDefinition): boolean {
  return (
    definition.mutatesWorkspace === true ||
    definition.scriptBinding === "package-script" ||
    definition.fixedScriptKey === "format"
  );
}

function projectCommandUsesUncontrolledExternalState(
  definition: ProjectCommandDefinition,
): boolean {
  return (
    definition.uncontrolledExternalState === true ||
    UNCONTROLLED_EXTERNAL_STATE_PROJECT_COMMAND_IDS.has(definition.commandId)
  );
}

export function projectCommandReusePolicy(
  definition: ProjectCommandDefinition,
): ProjectCommandReusePolicy {
  const policy = normalizeProjectCommandReusePolicy(definition.reusePolicy);
  if (
    policy === "never" ||
    projectCommandMutatesWorkspace(definition) ||
    projectCommandUsesUncontrolledExternalState(definition)
  ) {
    return "never";
  }
  if (policy === "workspace-snapshot" && definition.workspaceSnapshotApproved !== true) {
    return "never";
  }
  return policy;
}

export function getProjectCommandReusePolicy(
  definition: ProjectCommandDefinition,
): ProjectCommandReusePolicy {
  return projectCommandReusePolicy(definition);
}

export function isProjectCommandWorkspaceSnapshotApproved(
  definition: ProjectCommandDefinition,
): boolean {
  return (
    normalizeProjectCommandReusePolicy(definition.reusePolicy) === "workspace-snapshot" &&
    definition.workspaceSnapshotApproved === true &&
    !projectCommandMutatesWorkspace(definition) &&
    !projectCommandUsesUncontrolledExternalState(definition)
  );
}

function isProjectCommandId(commandId: string): commandId is ProjectCommandId {
  return definitions.some((definition) => definition.commandId === commandId);
}

export interface ResolvedCommandLine {
  readonly executable: string;
  readonly args: readonly string[];
  readonly fingerprintArgs?: readonly string[];
  readonly scriptHash?: string;
  /** Selected package script key, including any validated variant suffix. */
  readonly scriptKey?: string;
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
    ...(resolved.scriptKey !== undefined && resolved.scriptKey !== definition.fixedScriptKey
      ? { selectedScriptKey: resolved.scriptKey }
      : {}),
    scriptHash: resolved.scriptHash ?? null,
    ...(definition.binaryName === undefined ? {} : { binaryName: definition.binaryName }),
    ...(definition.acceptedExitCodes === undefined
      ? {}
      : { acceptedExitCodes: [...definition.acceptedExitCodes] }),
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
