const PROJECT_COMMAND_RESOLUTION_STAGES = [
  "probe",
  "detection",
  "binary-resolution",
  "spawn",
  "timeout",
  "policy",
] as const;

export type ProjectCommandResolutionStage = (typeof PROJECT_COMMAND_RESOLUTION_STAGES)[number];
export type ResolutionStage = ProjectCommandResolutionStage;

export type ResolutionErrorDetail = string | number | boolean | null | readonly string[];
export type ResolutionErrorDetails = Readonly<Record<string, ResolutionErrorDetail>>;

export class ProjectCommandResolutionError extends Error {
  readonly stage: ResolutionStage;
  readonly code: string;
  readonly details: ResolutionErrorDetails;

  constructor(stage: ResolutionStage, code: string, details: ResolutionErrorDetails = {}) {
    super(`Project command resolution failed during ${stage}`);
    this.name = "ProjectCommandResolutionError";
    this.stage = stage;
    this.code = code;
    this.details = Object.freeze({ ...details, stage, code });
  }
}

export function isProjectCommandResolutionError(
  error: unknown,
): error is ProjectCommandResolutionError {
  return error instanceof ProjectCommandResolutionError;
}
