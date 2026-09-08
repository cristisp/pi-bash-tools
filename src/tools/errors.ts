export const RESULT_CATEGORIES = [
  "PASS",
  "INVALID_REQUEST",
  "IMPLEMENTATION_FAILURE",
  "TEST_FAILURE",
  "FORMAT_FAILURE",
  "LINT_FAILURE",
  "TYPE_CHECK_FAILURE",
  "RESOLUTION_FAILURE",
  "POLICY_FAILURE",
  "ENVIRONMENT_FAILURE",
  "TIMEOUT",
  "SPAWN_FAILURE",
  "CANCELLED",
  "BLOCKED",
] as const;

export type ResultCategory = (typeof RESULT_CATEGORIES)[number];

/**
 * Stable, machine-readable information describing a tool failure.
 *
 * This deliberately contains no raw exception or command output. Future tool
 * families can use the same shape while retaining their own legacy details.
 */
export interface ToolErrorContract {
  readonly code: string;
  readonly category: Exclude<ResultCategory, "PASS">;
  readonly explanation: string;
  readonly invalidField?: string;
  readonly correctedExample?: unknown;
  readonly suggestedAction?: string;
  readonly retryable: boolean;
  readonly executed: boolean;
}

export function suggestedActionForCategory(category: ResultCategory): string | undefined {
  switch (category) {
    case "INVALID_REQUEST":
      return "Correct the invalid request field and retry the command.";
    case "IMPLEMENTATION_FAILURE":
      return "Inspect the command diagnostics before retrying the request.";
    case "TEST_FAILURE":
      return "Review the test diagnostics, fix the failures, and rerun the command.";
    case "FORMAT_FAILURE":
      return "Review the formatting diagnostics, fix the project files, and rerun the command.";
    case "LINT_FAILURE":
      return "Review the lint diagnostics, fix the project files, and rerun the command.";
    case "TYPE_CHECK_FAILURE":
      return "Review the type-check diagnostics, fix the project files, and rerun the command.";
    case "RESOLUTION_FAILURE":
      return "Review the project metadata and dependencies, then retry the command.";
    case "POLICY_FAILURE":
      return "Review the project command policy configuration, then retry the request.";
    case "ENVIRONMENT_FAILURE":
      return "Review the project environment and dependencies, then retry the command.";
    case "TIMEOUT":
      return "Review the command duration and project state before retrying the request.";
    case "SPAWN_FAILURE":
      return "Verify that the required executable and project dependencies are available, then retry.";
    case "CANCELLED":
      return "Retry the request if the command is still needed.";
    case "BLOCKED":
      return "Request authorization or adjust the project command policy before retrying.";
    case "PASS":
      return undefined;
    default:
      return undefined;
  }
}

export interface ToolErrorContractOptions {
  readonly code: string;
  readonly category: Exclude<ResultCategory, "PASS">;
  readonly explanation: string;
  readonly retryable: boolean;
  readonly executed: boolean;
  readonly invalidField?: string;
}

export function createToolErrorContract(contract: ToolErrorContract): ToolErrorContract {
  return Object.freeze({ ...contract });
}

export function buildToolErrorContract(options: ToolErrorContractOptions): ToolErrorContract {
  return createToolErrorContract({
    code: options.code,
    category: options.category,
    explanation: options.explanation,
    ...(options.invalidField === undefined ? {} : { invalidField: options.invalidField }),
    suggestedAction: suggestedActionForCategory(options.category),
    retryable: options.retryable,
    executed: options.executed,
  });
}

export function withToolErrorContract<T extends object>(
  details: T,
  contract: ToolErrorContract,
): Readonly<
  T & {
    readonly category: ToolErrorContract["category"];
    readonly executed: boolean;
    readonly error: ToolErrorContract;
    readonly suggestedAction?: string;
  }
> {
  return Object.freeze({
    ...details,
    ...(contract.suggestedAction === undefined
      ? {}
      : { suggestedAction: contract.suggestedAction }),
    category: contract.category,
    executed: contract.executed,
    error: contract,
  });
}
