import {
  hasPolicyPathControlCharacter,
  hasPolicyPathWildcard,
} from "../policy/format/validation.ts";

export type FilesystemPathResolutionReason =
  | "missing-target"
  | "unreadable"
  | "symlink"
  | "control-character"
  | "wildcard-path"
  | "invalid-path-form"
  | "unknown";

export interface FilesystemPathResolutionDiagnostic {
  readonly reason: FilesystemPathResolutionReason;
  readonly action: string;
}

const PATH_RESOLUTION_MESSAGES: Readonly<Record<FilesystemPathResolutionReason, string>> = {
  "missing-target": "Filesystem path does not exist",
  unreadable: "Filesystem path could not be read",
  symlink: "Filesystem path contains a symbolic link",
  "control-character": "Filesystem path contains a control character",
  "wildcard-path": "Filesystem path contains a wildcard character",
  "invalid-path-form": "Filesystem path is not a valid normalized absolute path",
  unknown: "Filesystem path could not be resolved",
};

export const filesystemPathResolutionActions: Readonly<
  Record<FilesystemPathResolutionReason, string>
> = Object.freeze({
  "missing-target": "Verify the path exists before retrying, or create it first.",
  unreadable: "Request a path the current user can read, or fix its permissions.",
  symlink: "Resolve the symbolic link to its real target, or remove the dangling link.",
  "control-character": "Request a plain literal path without control characters.",
  "wildcard-path": "Request a plain literal path without wildcard characters.",
  "invalid-path-form": "Request a normalized absolute path.",
  unknown: "Verify that the path exists, is readable, and contains no symbolic links.",
});

export class FilesystemPathResolutionError extends Error {
  readonly reason: FilesystemPathResolutionReason;

  constructor(reason: FilesystemPathResolutionReason, options?: { cause?: unknown }) {
    super(PATH_RESOLUTION_MESSAGES[reason], options);
    this.name = "FilesystemPathResolutionError";
    this.reason = reason;
  }
}

function pathResolutionErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

export function isMissingPathError(error: unknown): boolean {
  const code = pathResolutionErrorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function isUnreadablePathError(error: unknown): boolean {
  const code = pathResolutionErrorCode(error);
  return code === "EACCES" || code === "EPERM";
}

function isSymbolicLinkPathError(error: unknown): boolean {
  return (
    pathResolutionErrorCode(error) === "ELOOP" ||
    (error instanceof Error && error.message.includes("symbolic link"))
  );
}

function classifyPolicyPathFailure(path: string): FilesystemPathResolutionReason {
  if (hasPolicyPathControlCharacter(path)) {
    return "control-character";
  }
  if (hasPolicyPathWildcard(path)) {
    return "wildcard-path";
  }
  return "invalid-path-form";
}

export function classifyPathResolutionFailure(
  error: unknown,
  policyPath?: string,
): FilesystemPathResolutionReason {
  if (error instanceof FilesystemPathResolutionError) {
    return error.reason;
  }
  if (isMissingPathError(error)) {
    return "missing-target";
  }
  if (isUnreadablePathError(error)) {
    return "unreadable";
  }
  if (isSymbolicLinkPathError(error)) {
    return "symlink";
  }
  if (policyPath !== undefined) {
    return classifyPolicyPathFailure(policyPath);
  }
  return "unknown";
}

export function pathResolutionDiagnostic(
  error: unknown,
  policyPath?: string,
): FilesystemPathResolutionDiagnostic {
  const reason = classifyPathResolutionFailure(error, policyPath);
  return { reason, action: filesystemPathResolutionActions[reason] };
}

export function pathResolutionFailureDetails(
  error: unknown,
  policyPath?: string,
): { readonly resolutionFailure: FilesystemPathResolutionDiagnostic } {
  return { resolutionFailure: pathResolutionDiagnostic(error, policyPath) };
}

export function asPathResolutionError(
  error: unknown,
  policyPath?: string,
): FilesystemPathResolutionError {
  return error instanceof FilesystemPathResolutionError
    ? error
    : new FilesystemPathResolutionError(classifyPathResolutionFailure(error, policyPath), {
        cause: error,
      });
}
