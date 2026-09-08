import {
  getProjectCommandDefinition,
  type ProjectCommandDefinition,
} from "../project-command/definitions.ts";
import type {
  ProjectCommandResolver,
  ResolvedProjectCommand,
} from "../project-command/resolution.ts";
import { VerifyToolError } from "./schema.ts";
import type { NormalizedVerifyInput } from "./schema.ts";
import { VERIFY_PHASES, type VerifyPhase } from "./types.ts";

export const SCRIPT_BY_PHASE: Record<VerifyPhase, string> = {
  format: "format:check",
  lint: "lint",
  typecheck: "typecheck",
  test: "test",
};

const COMMAND_BY_PHASE: Record<
  VerifyPhase,
  "node_format" | "node_lint" | "node_typecheck" | "node_test"
> = {
  format: "node_format",
  lint: "node_lint",
  typecheck: "node_typecheck",
  test: "node_test",
};

export function stepDefinition(phase: VerifyPhase, script: string): ProjectCommandDefinition {
  const base = getProjectCommandDefinition(COMMAND_BY_PHASE[phase]);
  if (base === undefined) {
    throw new VerifyToolError(
      "implementation-failure",
      `missing definition for verify phase ${phase}`,
    );
  }
  return Object.freeze({
    ...base,
    fixedScriptKey: script,
    scriptVariantFamily: undefined,
    requiresVariant: false,
    args: Object.freeze(["run", script]),
    argvTemplate: Object.freeze(["<package-manager>", "run", script]),
  });
}

export interface PreparedStep {
  readonly phase: VerifyPhase;
  readonly resolved: ResolvedProjectCommand;
}

export async function resolveSteps(
  input: NormalizedVerifyInput,
  projectPath: string,
  resolver: ProjectCommandResolver,
  signal: AbortSignal | undefined,
  index = 0,
): Promise<PreparedStep[]> {
  if (index >= VERIFY_PHASES.length) return [];
  const phase = VERIFY_PHASES[index];
  if (input.omit.includes(phase))
    return resolveSteps(input, projectPath, resolver, signal, index + 1);
  if (signal?.aborted) throw new VerifyToolError("cancelled", "verify was cancelled");
  const script = input.scripts[phase] ?? SCRIPT_BY_PHASE[phase];
  const definition = stepDefinition(phase, script);
  const parameters =
    phase === "test"
      ? { commandId: definition.commandId, paths: input.paths }
      : { commandId: definition.commandId };
  let resolved: ResolvedProjectCommand;
  try {
    resolved = await resolver(definition, projectPath, signal, parameters);
  } catch (error) {
    if (signal?.aborted) throw new VerifyToolError("cancelled", "verify was cancelled");
    if (error instanceof VerifyToolError && error.code === "cancelled") throw error;
    throw new VerifyToolError(
      "resolution-failure",
      `verify could not resolve the ${phase} package script ${script}`,
    );
  }
  return [
    { phase, resolved },
    ...(await resolveSteps(input, projectPath, resolver, signal, index + 1)),
  ];
}
