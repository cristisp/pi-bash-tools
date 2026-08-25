import { ProjectCommandResolutionError } from "../errors.ts";
import { isWithinForwardedArgumentBudget } from "./argument-budget.ts";
import {
  NODE_E2E_GREP_MAX_LENGTH,
  NODE_E2E_PROJECT_MAX_LENGTH,
  PROJECT_COMMAND_MAX_PARAMETER_ITEMS,
  PROJECT_COMMAND_MAX_PATH_LENGTH,
} from "./limits.ts";
import type { NodeE2EParameters } from "./types.ts";

function buildE2EForwardedArgs(parameters: NodeE2EParameters): string[] {
  const args: string[] = [];
  if (parameters.grep !== undefined) {
    args.push("--grep", parameters.grep);
  }
  for (const project of parameters.projects ?? []) {
    args.push("--project", project);
  }
  if (parameters.workers !== undefined) {
    args.push("--workers", parameters.workers.toString(10));
  }
  if (parameters.retries !== undefined) {
    args.push("--retries", parameters.retries.toString(10));
  }
  if (parameters.headed === true) {
    args.push("--headed");
  }
  if (parameters.list === true) {
    args.push("--list");
  }
  args.push(...parameters.paths);
  return args;
}

function hasE2EArgumentConstructionBounds(parameters: NodeE2EParameters): boolean {
  return (
    parameters.paths.length <= PROJECT_COMMAND_MAX_PARAMETER_ITEMS &&
    parameters.paths.every((path) => path.length <= PROJECT_COMMAND_MAX_PATH_LENGTH) &&
    (parameters.projects?.length ?? 0) <= PROJECT_COMMAND_MAX_PARAMETER_ITEMS &&
    (parameters.projects?.every((project) => project.length <= NODE_E2E_PROJECT_MAX_LENGTH) ??
      true) &&
    (parameters.grep === undefined || parameters.grep.length <= NODE_E2E_GREP_MAX_LENGTH)
  );
}

export function e2eForwardedArgumentsWithinBudget(parameters: NodeE2EParameters): boolean {
  return (
    hasE2EArgumentConstructionBounds(parameters) &&
    isWithinForwardedArgumentBudget(buildE2EForwardedArgs(parameters))
  );
}

export function e2eForwardedArgs(parameters: NodeE2EParameters): readonly string[] {
  if (!hasE2EArgumentConstructionBounds(parameters)) {
    throw new ProjectCommandResolutionError("probe", "e2e-arguments-too-large");
  }
  const args = buildE2EForwardedArgs(parameters);
  if (!isWithinForwardedArgumentBudget(args)) {
    throw new ProjectCommandResolutionError("probe", "e2e-arguments-too-large");
  }
  return Object.freeze(args);
}

export function effectiveNodeE2EParameters(
  parameters: NodeE2EParameters,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...(parameters.paths.length === 0 ? {} : { paths: parameters.paths }),
    ...(parameters.grep === undefined ? {} : { grep: parameters.grep }),
    ...(parameters.projects === undefined ? {} : { projects: parameters.projects }),
    ...(parameters.workers === undefined ? {} : { workers: parameters.workers }),
    ...(parameters.retries === undefined ? {} : { retries: parameters.retries }),
    ...(parameters.headed === undefined ? {} : { headed: parameters.headed }),
    ...(parameters.list === undefined ? {} : { list: parameters.list }),
  });
}
