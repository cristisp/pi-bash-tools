import type { ProjectCommandExecutionOutcome } from "../project-command/execution.ts";
import type {
  VerifyEvidenceRecord,
  VerifyOutput,
  VerifyOutputChunk,
  VerifyRepositoryState,
  VerifyStepResult,
} from "./types.ts";

const MAX_FAILURE_TAIL = 8 * 1024;
const ANSI_SGR_PATTERN = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;]*m`, "gu");

export function outputChunk(value: ProjectCommandExecutionOutcome["stdout"]): VerifyOutputChunk {
  return {
    text: value.text,
    truncated: value.truncated,
    totalBytes: value.totalBytes,
    totalLines: value.totalLines,
  };
}

export function emptyChunk(): VerifyOutputChunk {
  return { text: "", truncated: false, totalBytes: 0, totalLines: 0 };
}

function tail(value: string): string | undefined {
  const sanitized = value.replace(ANSI_SGR_PATTERN, "");
  if (sanitized.length === 0) return undefined;
  return sanitized.length <= MAX_FAILURE_TAIL ? sanitized : sanitized.slice(-MAX_FAILURE_TAIL);
}

export function failureTail(step: VerifyStepResult): string | undefined {
  return tail(step.stderr.text) ?? tail(step.stdout.text);
}

function compactChunk(value: VerifyOutputChunk): VerifyOutputChunk {
  return { ...value, text: "" };
}

function compactStep(step: VerifyStepResult, reused: boolean): VerifyStepResult {
  const compact = {
    ...step,
    executed: reused ? false : step.executed,
    stdout: compactChunk(step.stdout),
    stderr: compactChunk(step.stderr),
  };
  delete compact.resolvedCommand;
  delete compact.executable;
  return compact;
}

function uniqueFailureTail(
  steps: readonly VerifyStepResult[],
  candidate: string | undefined,
): string | undefined {
  return candidate !== undefined && steps.some((step) => step.failureTail === candidate)
    ? undefined
    : candidate;
}

function stateMatches(
  recorded: VerifyRepositoryState | undefined,
  current: VerifyRepositoryState | undefined,
): "matches" | "mismatch" | "unreadable" {
  if (current === undefined || recorded === undefined) return "unreadable";
  return JSON.stringify(recorded) === JSON.stringify(current) ? "matches" : "mismatch";
}

function stateOutput(
  recorded: VerifyRepositoryState | undefined,
  current: VerifyRepositoryState | undefined,
): Pick<
  VerifyOutput,
  "recordedRepositoryState" | "currentRepositoryState" | "repositoryStateStatus"
> {
  return {
    ...(recorded === undefined ? {} : { recordedRepositoryState: recorded }),
    ...(current === undefined ? {} : { currentRepositoryState: current }),
    repositoryStateStatus: stateMatches(recorded, current),
  };
}

function recordMetadata(
  record: VerifyEvidenceRecord,
): Pick<
  VerifyOutput,
  | "repositoryState"
  | "provenance"
  | "publication"
  | "mutating"
  | "concurrentExecutions"
  | "stateDrift"
  | "sharedExecution"
> {
  return {
    ...(record.repositoryState === undefined ? {} : { repositoryState: record.repositoryState }),
    ...(record.provenance === undefined ? {} : { provenance: record.provenance }),
    ...(record.publication === undefined ? {} : { publication: record.publication }),
    ...(record.mutating === undefined ? {} : { mutating: record.mutating }),
    ...(record.concurrentExecutions === undefined
      ? {}
      : { concurrentExecutions: record.concurrentExecutions }),
    ...(record.stateDrift === undefined ? {} : { stateDrift: record.stateDrift }),
    ...(record.sharedExecution === undefined ? {} : { sharedExecution: record.sharedExecution }),
  };
}

function reusedOutput(
  record: VerifyEvidenceRecord,
  currentRepositoryState: VerifyRepositoryState | undefined,
  perStep: readonly VerifyStepResult[],
): VerifyOutput {
  const topLevelFailureTail = uniqueFailureTail(perStep, record.failureTail);
  return {
    status: "unchanged",
    verdict: record.verdict,
    ref: record.ref,
    projectPath: record.projectPath,
    perStep,
    ...(topLevelFailureTail === undefined ? {} : { failureTail: topLevelFailureTail }),
    reused: true,
    covers: record.covers,
    ...recordMetadata(record),
    ...stateOutput(record.repositoryState, currentRepositoryState),
  };
}

export function completedOutput(
  record: VerifyEvidenceRecord,
  reused: boolean,
  ref: string | undefined,
  currentRepositoryState?: VerifyRepositoryState,
): VerifyOutput {
  const perStep = record.perStep.map((step) => compactStep(step, reused));
  const topLevelFailureTail = uniqueFailureTail(perStep, record.failureTail);
  return {
    status: reused ? "unchanged" : "completed",
    verdict: record.verdict,
    ...(ref === undefined ? {} : { ref }),
    projectPath: record.projectPath,
    perStep,
    ...(topLevelFailureTail === undefined ? {} : { failureTail: topLevelFailureTail }),
    reused,
    covers: record.covers,
    ...recordMetadata(record),
    ...stateOutput(record.repositoryState, currentRepositoryState),
  };
}

export function compactOutput(
  record: VerifyEvidenceRecord,
  currentRepositoryState?: VerifyRepositoryState,
): VerifyOutput {
  return reusedOutput(
    record,
    currentRepositoryState,
    record.perStep.map((step) => compactStep(step, true)),
  );
}

function fullChunk(value: VerifyOutputChunk): VerifyOutputChunk {
  return { ...value, text: value.text.replace(ANSI_SGR_PATTERN, "") };
}

function fullStep(step: VerifyStepResult): VerifyStepResult {
  const full = {
    ...step,
    executed: false,
    stdout: fullChunk(step.stdout),
    stderr: fullChunk(step.stderr),
  };
  if (full.failureTail === undefined || full.stdout.truncated || full.stderr.truncated) {
    return full;
  }
  const { failureTail: stepFailureTail, ...withoutFailureTail } = full;
  void stepFailureTail;
  return withoutFailureTail;
}

export function repositoryStateMatches(
  recorded: VerifyRepositoryState | undefined,
  current: VerifyRepositoryState | undefined,
): "matches" | "mismatch" | "unreadable" {
  return stateMatches(recorded, current);
}

export function fullOutput(
  record: VerifyEvidenceRecord,
  currentRepositoryState?: VerifyRepositoryState,
): VerifyOutput {
  return reusedOutput(record, currentRepositoryState, record.perStep.map(fullStep));
}
