import type { AuthorizationErrorKind } from "../authorization.ts";
import {
  buildToolErrorContract,
  createToolErrorContract,
  suggestedActionForCategory,
  withToolErrorContract,
  type ToolErrorContract,
} from "../errors.ts";
import { isRecord } from "../value-validation.ts";

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
    this.details = withToolErrorContract(isRecord(details) ? details : {}, this.contract);
  }
}

export function filesystemContract(
  options: Parameters<typeof buildToolErrorContract>[0],
): ToolErrorContract {
  return buildToolErrorContract(options);
}

export function filesystemError(
  message: string,
  contract: ToolErrorContract,
  name?: string,
  details: Readonly<Record<string, unknown>> = {},
): FilesystemToolError {
  const error = new FilesystemToolError(
    message,
    withToolErrorContract(details, contract),
    contract,
  );
  if (name !== undefined) {
    error.name = name;
  }
  return error;
}

function filesystemPolicyError(
  message: string,
  code: string,
  explanation: string,
  retryable = true,
): FilesystemToolError {
  return filesystemError(
    message,
    filesystemContract({
      code,
      category: "POLICY_FAILURE",
      explanation,
      retryable,
      executed: false,
    }),
  );
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
  return filesystemPolicyError(
    "Unable to evaluate filesystem access policy",
    "policy-evaluation-failure",
    "The filesystem access policy could not be evaluated.",
  );
}

export function filesystemPolicyLoadError(): FilesystemToolError {
  return filesystemPolicyError(
    "Unable to load filesystem access policy",
    "policy-load-failure",
    "The filesystem access policy could not be loaded.",
  );
}

export function filesystemPolicyPathResolutionError(): FilesystemToolError {
  return filesystemPolicyError(
    "Filesystem access policy path could not be safely resolved",
    "policy-path-resolution-failure",
    "The filesystem access policy path could not be safely resolved.",
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

export function filesystemEditDiagnosticError(
  code: "edit-empty-old-text" | "edit-no-match" | "edit-ambiguous" | "edit-overlap",
  message: string,
  details: Record<string, unknown>,
): FilesystemToolError {
  return filesystemError(
    message,
    filesystemContract({
      code,
      category: "INVALID_REQUEST",
      explanation: "The edit could not identify one unique matching region.",
      retryable: false,
      executed: false,
    }),
    undefined,
    details,
  );
}
