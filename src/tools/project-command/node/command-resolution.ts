import { type ProjectCommandDefinition, type ResolvedCommandLine } from "../definitions.ts";
import { ProjectCommandResolutionError, type ResolutionErrorDetails } from "../errors.ts";
import { nodeDependencyListArgsForManager } from "../package-manager/detection.ts";
import { normalizeNodeTestParametersInternal } from "../parameters/normalization.ts";
import { validateNodeTestPaths } from "../parameters/validation.ts";
import type { ResolvedProjectCommand } from "../resolution/types.ts";
import { readNodeProjectState } from "./project-state.ts";
import {
  isValidNodePackageScriptVariant,
  nodePackageScriptKey,
  nodePackageScriptVariantKey,
} from "./package-script.ts";
import type { NodeProjectResolutionOptions } from "../node.ts";
import type { NodeProjectState } from "./types.ts";

function resolutionError(
  stage: "probe" | "detection" | "binary-resolution",
  code: string,
  details: ResolutionErrorDetails = {},
): ProjectCommandResolutionError {
  return new ProjectCommandResolutionError(stage, code, details);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandScript(definition: ProjectCommandDefinition, parameters: unknown): string {
  const script = nodePackageScriptKey(definition, parameters);
  if (script === undefined) {
    if (definition.fixedScriptKey === undefined) {
      throw resolutionError("probe", "invalid-node-command-definition");
    }
    throw resolutionError("probe", "missing-package-script-variant", {
      basePackageScript: definition.fixedScriptKey,
    });
  }
  return script;
}

function requireValidVariant(definition: ProjectCommandDefinition, parameters: unknown): void {
  const variant = isRecord(parameters) ? parameters.variant : undefined;
  if (variant === undefined) return;
  if (
    typeof variant !== "string" ||
    !isValidNodePackageScriptVariant(variant) ||
    definition.scriptVariantFamily === undefined ||
    nodePackageScriptVariantKey(definition.scriptVariantFamily, variant) === undefined
  ) {
    throw resolutionError("probe", "invalid-package-script-variant", {
      basePackageScript: definition.fixedScriptKey ?? "",
      variant: typeof variant === "string" ? variant : "",
    });
  }
}

function displayCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args].join(" ");
}

type ResolvedNodeScriptParameters = {
  readonly args: readonly string[];
  readonly effective: Readonly<Record<string, unknown>>;
};

async function resolveNodeTestScriptParameters(
  parameters: unknown,
  projectPath: string,
): Promise<ResolvedNodeScriptParameters> {
  if (
    parameters !== undefined &&
    (!isRecord(parameters) ||
      Object.keys(parameters).some(
        (key) => key !== "commandId" && key !== "paths" && key !== "variant",
      ))
  ) {
    throw resolutionError("probe", "invalid-test-parameters");
  }
  const paths = validateNodeTestPaths(
    parameters === undefined || !isRecord(parameters) ? undefined : parameters.paths,
  );
  const normalized = await normalizeNodeTestParametersInternal(paths, projectPath);
  return {
    args: normalized.paths.length === 0 ? [] : ["--", ...normalized.paths],
    effective: Object.freeze({ paths: normalized.paths }),
  };
}

async function resolveNodeScriptParameters(
  definition: ProjectCommandDefinition,
  parameters: unknown,
  projectPath: string,
): Promise<ResolvedNodeScriptParameters> {
  const variant = isRecord(parameters) ? parameters.variant : undefined;
  const variantParameters =
    typeof variant === "string" ? Object.freeze({ variant }) : Object.freeze({});
  if (definition.commandId === "node_test") {
    const test = await resolveNodeTestScriptParameters(parameters, projectPath);
    return {
      args: test.args,
      effective: Object.freeze({ ...test.effective, ...variantParameters }),
    };
  }
  return { args: [], effective: variantParameters };
}

type DetectedNodeProjectState = NodeProjectState & {
  readonly manifest: NonNullable<NodeProjectState["manifest"]>;
  readonly detected: NonNullable<NodeProjectState["detected"]>;
};

function requireDetectedNodeProjectState(state: NodeProjectState): DetectedNodeProjectState {
  const { detected, manifest } = state;
  if (detected === null || manifest === null) {
    throw resolutionError("detection", "package-manager-unavailable");
  }
  return { ...state, detected, manifest };
}

async function resolveNodeProjectInfoCommand(
  definition: ProjectCommandDefinition,
  projectPath: string,
  options: NodeProjectResolutionOptions,
): Promise<ResolvedProjectCommand> {
  const state = await readNodeProjectState(projectPath, options, {
    allowMissing: true,
    probeFallow: true,
  });
  return Object.freeze({
    definition,
    executable: "in-process",
    args: [],
    fingerprintArgs: ["node_project_info"],
    displayCommand: "node_project_info (in-process)",
    effectiveParameters: Object.freeze({}),
    structuredDetails: state.info,
  });
}

function resolveNodeDependencyListCommand(
  definition: ProjectCommandDefinition,
  state: NodeProjectState,
): ResolvedProjectCommand {
  const detectedState = requireDetectedNodeProjectState(state);
  const args = [
    ...nodeDependencyListArgsForManager(
      detectedState.detected.manager,
      detectedState.detected.version,
    ),
  ];
  if (detectedState.managerExecutable === undefined) {
    throw resolutionError("binary-resolution", "package-manager-executable-unavailable", {
      manager: detectedState.detected.manager,
    });
  }
  const resolved: ResolvedCommandLine = {
    executable: detectedState.managerExecutable,
    args,
    fingerprintArgs: [detectedState.detected.manager, ...args],
  };
  return Object.freeze({
    definition,
    ...resolved,
    displayCommand: displayCommand(resolved.executable, resolved.args),
    effectiveParameters: Object.freeze({}),
  });
}

async function resolveNodeScriptCommand(
  definition: ProjectCommandDefinition,
  parameters: unknown,
  projectPath: string,
  state: NodeProjectState,
): Promise<ResolvedProjectCommand> {
  requireValidVariant(definition, parameters);
  const detectedState = requireDetectedNodeProjectState(state);
  const script = commandScript(definition, parameters);
  if (!Object.prototype.hasOwnProperty.call(detectedState.manifest.scripts, script)) {
    throw resolutionError("probe", "inapplicable-command", {
      commandId: definition.commandId,
      requiredPackageScript: script,
      packageManagerCommand: `${detectedState.detected.manager} run ${script}`,
      availableScripts: Object.keys(detectedState.manifest.scripts).sort(),
      applicableCommands: detectedState.info.applicableCommands,
    });
  }
  if (detectedState.managerExecutable === undefined) {
    throw resolutionError("binary-resolution", "package-manager-executable-unavailable", {
      manager: detectedState.detected.manager,
    });
  }
  const nodeParameters = await resolveNodeScriptParameters(definition, parameters, projectPath);
  const args = ["run", script, ...nodeParameters.args];
  const resolved: ResolvedCommandLine = {
    executable: detectedState.managerExecutable,
    args,
    fingerprintArgs: definition.argvTemplate,
    scriptHash: detectedState.scriptHash ?? undefined,
    scriptKey: script,
  };
  return Object.freeze({
    definition,
    ...resolved,
    displayCommand: displayCommand(resolved.executable, resolved.args),
    effectiveParameters: nodeParameters.effective,
    script: detectedState.manifest.scripts[script],
  });
}

export async function resolveNodeProjectCommandInternal(
  definition: ProjectCommandDefinition,
  projectPath: string,
  parameters?: unknown,
  options: NodeProjectResolutionOptions = {},
): Promise<ResolvedProjectCommand> {
  if (definition.commandId === "node_project_info") {
    return resolveNodeProjectInfoCommand(definition, projectPath, options);
  }
  const state = await readNodeProjectState(projectPath, options, {
    allowMissing: false,
    probeFallow: false,
  });
  if (definition.commandId === "node_deps_list") {
    return resolveNodeDependencyListCommand(definition, state);
  }
  return resolveNodeScriptCommand(definition, parameters, projectPath, state);
}
