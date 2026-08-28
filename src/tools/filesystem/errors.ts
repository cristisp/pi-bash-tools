import {
  createToolErrorContract,
  suggestedActionForCategory,
  withToolErrorContract,
  type ResultCategory,
  type ToolErrorContract,
} from "../errors.ts";
import type { AuthorizationErrorKind } from "../authorization.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class FilesystemToolError extends Error {
  readonly details: unknown;
  readonly contract: ToolErrorContract;

  constructor(message: string, details?: unknown, contract?: ToolErrorContract) {
    super(message);
    this.name = "FilesystemToolError";
    this.contract =
      contract ??
      createToolErrorContract({
        code: "filesystem-error",
        category: "IMPLEMENTATION_FAILURE",
        explanation: message,
        suggestedAction: suggestedActionForCategory("IMPLEMENTATION_FAILURE"),
        retryable: true,
        executed: false,
      });
    this.details = isRecord(details)
      ? withToolErrorContract(details, this.contract)
      : withToolErrorContract({}, this.contract);
  }
}

interface FilesystemContractOptions {
  readonly code: string;
  readonly category: Exclude<ResultCategory, "PASS">;
  readonly explanation: string;
  readonly retryable: boolean;
  readonly executed: boolean;
  readonly invalidField?: string;
}

export function filesystemContract(options: FilesystemContractOptions): ToolErrorContract {
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

export function filesystemError(
  message: string,
  contract: ToolErrorContract,
  name?: string,
): FilesystemToolError {
  const error = new FilesystemToolError(message, withToolErrorContract({}, contract), contract);
  if (name !== undefined) {
    error.name = name;
  }
  return error;
}

export function filesystemInvalidRequest(
  message: string,
  invalidField?: string,
): FilesystemToolError {
  return filesystemError(
    message,
    filesystemContract({
      code: "invalid-request",
      category: "INVALID_REQUEST",
      explanation: "The filesystem request contains an invalid value.",
      invalidField,
      retryable: false,
      executed: false,
    }),
  );
}

export function filesystemCancellationError(
  message = "Filesystem operation cancelled",
  executed = false,
): FilesystemToolError {
  return filesystemError(
    message,
    filesystemContract({
      code: "cancelled",
      category: "CANCELLED",
      explanation: "The filesystem operation was cancelled.",
      retryable: true,
      executed,
    }),
    "AbortError",
  );
}

export function filesystemAuthorizationContract(
  kind: Exclude<AuthorizationErrorKind, "cancelled">,
): ToolErrorContract {
  switch (kind) {
    case "denied":
      return filesystemContract({
        code: "policy-denied",
        category: "BLOCKED",
        explanation: "Filesystem access is denied by policy.",
        retryable: false,
        executed: false,
      });
    case "denied-once":
      return filesystemContract({
        code: "policy-denied-once",
        category: "BLOCKED",
        explanation: "Filesystem access was denied for this request.",
        retryable: false,
        executed: false,
      });
    case "not-authorized":
      return filesystemContract({
        code: "policy-not-authorized",
        category: "BLOCKED",
        explanation: "Filesystem access requires authorization unavailable in this mode.",
        retryable: false,
        executed: false,
      });
    case "unsafe-global":
      return filesystemContract({
        code: "policy-unsafe-global",
        category: "BLOCKED",
        explanation: "Filesystem access cannot be authorized globally.",
        retryable: false,
        executed: false,
      });
    case "timeout":
      return filesystemContract({
        code: "confirmation-timeout",
        category: "TIMEOUT",
        explanation: "Filesystem access confirmation timed out.",
        retryable: true,
        executed: false,
      });
    case "confirmation":
    case "dismissed":
      return filesystemContract({
        code: "policy-confirmation-failure",
        category: "POLICY_FAILURE",
        explanation: "Filesystem access confirmation failed.",
        retryable: true,
        executed: false,
      });
    case "save":
      return filesystemContract({
        code: "policy-save-failure",
        category: "POLICY_FAILURE",
        explanation: "The filesystem access policy could not be saved.",
        retryable: true,
        executed: false,
      });
    case "load":
      return filesystemContract({
        code: "policy-evaluation-failure",
        category: "POLICY_FAILURE",
        explanation: "The filesystem access policy could not be evaluated.",
        retryable: true,
        executed: false,
      });
    case "invalid-choice":
      return filesystemContract({
        code: "policy-invalid-choice",
        category: "POLICY_FAILURE",
        explanation: "Filesystem access confirmation returned an invalid choice.",
        retryable: true,
        executed: false,
      });
    default:
      throw new Error("Unsupported filesystem authorization error kind");
  }
}

export function filesystemPolicyEvaluationError(): FilesystemToolError {
  return filesystemError(
    "Unable to evaluate filesystem access policy",
    filesystemContract({
      code: "policy-evaluation-failure",
      category: "POLICY_FAILURE",
      explanation: "The filesystem access policy could not be evaluated.",
      retryable: true,
      executed: false,
    }),
  );
}

export function filesystemPolicyLoadError(): FilesystemToolError {
  return filesystemError(
    "Unable to load filesystem access policy",
    filesystemContract({
      code: "policy-load-failure",
      category: "POLICY_FAILURE",
      explanation: "The filesystem access policy could not be loaded.",
      retryable: true,
      executed: false,
    }),
  );
}

export function filesystemPolicyPathResolutionError(): FilesystemToolError {
  return filesystemError(
    "Filesystem access policy path could not be safely resolved",
    filesystemContract({
      code: "policy-path-resolution-failure",
      category: "POLICY_FAILURE",
      explanation: "The filesystem access policy path could not be safely resolved.",
      retryable: true,
      executed: false,
    }),
  );
}

export function filesystemInspectionError(message: string): FilesystemToolError {
  return filesystemError(
    message,
    filesystemContract({
      code: "filesystem-inspection-failure",
      category: "IMPLEMENTATION_FAILURE",
      explanation: "The filesystem target could not be inspected.",
      retryable: true,
      executed: false,
    }),
  );
}

export function filesystemMutationError(message: string): FilesystemToolError {
  return filesystemError(
    message,
    filesystemContract({
      code: "filesystem-mutation-failure",
      category: "IMPLEMENTATION_FAILURE",
      explanation: "The filesystem mutation could not be completed.",
      retryable: true,
      executed: true,
    }),
  );
}
