import { ProjectCommandResolutionError, type ResolutionErrorDetails } from "../../errors.ts";

export function projectStateResolutionError(
  stage: "probe" | "detection" | "binary-resolution",
  code: string,
  details: ResolutionErrorDetails = {},
): ProjectCommandResolutionError {
  return new ProjectCommandResolutionError(stage, code, details);
}

export function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
