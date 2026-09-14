import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  aggregateSharedEvidenceOutput,
  EVIDENCE_PRODUCER,
  sharedEvidenceContentHash,
  sharedEvidenceRequestHash,
  sharedWorkspaceBlock,
} from "../../evidence/envelope.ts";
import type {
  AuthorizationOutcomeObserver,
  AuthorizationOutcomeRecorder,
} from "../../observability/authorization-outcome.ts";
import { createAuthorizationOutcomeObserver } from "../../observability/authorization-outcome.ts";
import {
  createProjectCommandInvocationMeasurements,
  projectCommandInvocationLookupOutcome,
  recordProjectCommandInvocation,
  type ProjectCommandInvocationLookupMetadata,
  type ProjectCommandInvocationLookupOutcome,
  type ProjectCommandInvocationReason,
  type ProjectCommandInvocationPublicationMetadata,
  type ProjectCommandInvocationRecorder,
} from "../../observability/project-command-invocation.ts";
import type { AuthorizationRetryTracker } from "../authorization-retry.ts";
import { authorizeOrPrompt, type AuthorizationErrorKind } from "../authorization.ts";
import { awaitWithAbort } from "../await-with-abort.ts";
import { renderCallLine } from "../call-render.ts";
import type { ResultCategory } from "../errors.ts";
import type { GitExec } from "../git/execution.ts";
import { findProjectCommandPolicyDecision } from "../policy/decisions.ts";
import { createPolicyStore, createPolicyStoreForTesting } from "../policy/store.ts";
import type { PolicyFileSystem, PolicyStore } from "../policy/types.ts";
import type { ProjectCommandCacheDecision } from "../project-command/cache.ts";
import { createProjectCommandExecutor } from "../project-command/execution.ts";
import type { ProjectCommandExecutionOutcome } from "../project-command/execution.ts";
import { projectCommandMutatesWorkspace } from "../project-command/mutability.ts";
import {
  effectiveOrchestrationFlowId,
  readProjectCommandOrchestrationContext,
} from "../project-command/orchestration.ts";
import { createProjectCommandRepositoryStateReader } from "../project-command/repository-state.ts";
import type { ProjectCommandRepositoryStateReader } from "../project-command/repository-state.ts";
import {
  resolveProjectCommand,
  type ProjectCommandResolver,
  type ResolvedProjectCommand,
} from "../project-command/resolution.ts";
import type { ProjectCommandExecutor } from "../project-command/runner.ts";
import { createVerifyEvidenceCache, type VerifyEvidenceCache } from "./cache.ts";
import {
  compactOutput,
  completedOutput,
  emptyChunk,
  failureTail,
  fullOutput,
  outputChunk,
  repositoryStateMatches,
} from "./output.ts";
import {
  validateVerifyInput,
  verifyInputSchema,
  VerifyToolError,
  type NormalizedVerifyInput,
  type VerifyInput,
} from "./schema.ts";
import { SCRIPT_BY_PHASE, stepDefinition, type PreparedStep, resolveSteps } from "./steps.ts";
import {
  VERIFY_CACHE_FORMAT_VERSION,
  VERIFY_PHASES,
  type VerifyEvidenceRecord,
  type VerifyOutput,
  type VerifyPhase,
  type VerifyRepositoryState,
  type VerifyStepResult,
} from "./types.ts";

export type VerifyToolContext = Omit<
  Pick<ExtensionContext, "cwd" | "signal" | "hasUI" | "mode" | "ui">,
  "ui"
> & {
  readonly ui: Pick<ExtensionContext["ui"], "select">;
  readonly sessionManager?: Pick<ExtensionContext["sessionManager"], "getSessionId">;
};

type VerifyToolExecute = (
  toolCallId: string,
  params: VerifyInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<VerifyOutput> | undefined,
  ctx: VerifyToolContext,
) => Promise<AgentToolResult<VerifyOutput>>;

export interface VerifyToolOptions {
  readonly policy?: PolicyStore;
  readonly executor?: ProjectCommandExecutor;
  readonly resolver?: ProjectCommandResolver;
  readonly repositoryStateReader?: ProjectCommandRepositoryStateReader;
  readonly cache?: VerifyEvidenceCache;
  readonly aggregateTimeoutMs?: number;
  readonly authorizationOutcomeRecorder?: AuthorizationOutcomeRecorder;
  readonly authorizationRetryTracker?: AuthorizationRetryTracker;
  readonly stepTimeoutMs?: number;
  readonly configPath?: string;
  readonly fs?: Partial<PolicyFileSystem>;
  readonly invocationRecorder?: ProjectCommandInvocationRecorder;
}

export type VerifyToolDefinition = Omit<
  ToolDefinition<typeof verifyInputSchema, VerifyOutput>,
  "execute"
> & { execute: VerifyToolExecute };

const DEFAULT_AGGREGATE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_STEP_TIMEOUT_MS = 2 * 60 * 1000;

interface VerifyStepSingleFlight {
  readonly promise: Promise<ProjectCommandExecutionOutcome>;
  readonly controller: AbortController;
  active: number;
  settled: boolean;
}

const VERIFY_STEP_SINGLE_FLIGHTS = new Map<string, VerifyStepSingleFlight>();

function result(details: VerifyOutput): AgentToolResult<VerifyOutput> {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function displayCommand(resolved: ResolvedProjectCommand): string {
  return resolved.displayCommand ?? [resolved.executable, ...resolved.args].join(" ");
}

function durationMs(startedAt: number): number {
  const duration = performance.now() - startedAt;
  return Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : 0;
}

function authorizationError(kind: AuthorizationErrorKind): VerifyToolError {
  if (kind === "cancelled" || kind === "dismissed") {
    return new VerifyToolError("cancelled", "verify authorization was cancelled");
  }
  return new VerifyToolError(`policy-${kind}`, `verify authorization failed: ${kind}`);
}

async function authorizeVerify(
  policy: PolicyStore,
  ctx: VerifyToolContext,
  signal: AbortSignal | undefined,
  identity: { readonly commandId: string; readonly fingerprint: string },
  commands: readonly string[],
  observe: AuthorizationOutcomeObserver | undefined,
  retryTracker: AuthorizationRetryTracker | undefined,
): Promise<void> {
  let loaded;
  try {
    loaded = await policy.load(ctx.cwd);
  } catch {
    observe?.({
      outcome: "policy-load-failure",
      decisionPersisted: false,
      promptEmitted: false,
      promptWaitMs: 0,
    });
    throw new VerifyToolError("policy-load-failure", "verify policy could not be loaded");
  }
  await authorizeOrPrompt({
    identity,
    loaded,
    context: ctx,
    signal,
    globalSafe: false,
    allowGlobal: false,
    deferAllowPersistence: false,
    findDecision: (current, currentIdentity) =>
      findProjectCommandPolicyDecision(current, currentIdentity, false),
    reload: async () => {
      const reloaded = await policy.load(ctx.cwd);
      return reloaded;
    },
    recordDecisions: (projectPath, requests, requestSignal) =>
      policy.recordDecisions(projectPath, requests, requestSignal),
    makeRequest: (currentIdentity, decision) => ({
      kind: "project-command" as const,
      identity: currentIdentity,
      decision,
      globalSafe: false,
    }),
    promptText: () => `Authorize verify: ${commands.join("; ")}`,
    error: authorizationError,
    observe,
    retry:
      retryTracker === undefined
        ? undefined
        : {
            tracker: retryTracker,
            surface: "verify",
            sessionId: retrySessionId(ctx),
            fingerprint: identity.fingerprint,
          },
  });
}

function repositoryState(
  projectPath: string,
  state: Awaited<ReturnType<ProjectCommandRepositoryStateReader>>,
): VerifyRepositoryState | undefined {
  if (state === undefined) return undefined;
  return {
    ...state,
    workingDirectory: projectPath,
  };
}

async function readVerifyRepositoryState(
  repositoryStateReader: ProjectCommandRepositoryStateReader,
  projectPath: string,
  signal: AbortSignal | undefined,
): Promise<VerifyRepositoryState | undefined> {
  let observedState: Awaited<ReturnType<ProjectCommandRepositoryStateReader>>;
  try {
    observedState = await repositoryStateReader(projectPath, signal);
  } catch {
    if (signal?.aborted) throw new VerifyToolError("cancelled", "verify was cancelled");
    throw new VerifyToolError(
      "repository-state-failure",
      "verify could not determine repository state",
    );
  }
  if (signal?.aborted) throw new VerifyToolError("cancelled", "verify was cancelled");
  return repositoryState(projectPath, observedState);
}

function cacheKey(
  projectPath: string,
  state: VerifyRepositoryState | undefined,
  prepared: readonly PreparedStep[],
  input: NormalizedVerifyInput,
): string {
  return hash({
    projectPath,
    repositoryState: state,
    commands: prepared.map(({ phase, resolved }) => ({
      phase,
      executable: resolved.executable,
      args: [...resolved.args],
      displayCommand: displayCommand(resolved),
      scriptKey: resolved.scriptKey,
      scriptFingerprint: scriptFingerprint(resolved),
    })),
    paths: input.paths,
    omit: input.omit,
    scripts: input.scripts,
    continueOnFailure: input.continueOnFailure,
    covers: input.covers,
  });
}

function scriptFingerprint(resolved: ResolvedProjectCommand): string {
  return resolved.script === undefined ? (resolved.scriptHash ?? hash("")) : hash(resolved.script);
}

function verificationIdentity(prepared: readonly PreparedStep[], input: NormalizedVerifyInput) {
  return {
    commandId: "verify",
    fingerprint: hash({
      commandId: "verify",
      // Authorization is bound to the package-script bodies selected for each
      // phase. Test paths affect execution/cache identity, but not consent.
      scripts: prepared.map(({ phase, resolved }) => ({
        phase,
        scriptKey: resolved.scriptKey,
        scriptFingerprint: scriptFingerprint(resolved),
      })),
      omit: input.omit,
      continueOnFailure: input.continueOnFailure,
    }),
  };
}

function notRunStep(phase: VerifyPhase, reason: string): VerifyStepResult {
  return {
    phase,
    status: "not-run",
    verdict: "not-run",
    exitCode: null,
    signal: null,
    durationMs: 0,
    executed: false,
    stdout: emptyChunk(),
    stderr: emptyChunk(),
    reason,
  };
}

function omittedStep(phase: VerifyPhase): VerifyStepResult {
  return {
    phase,
    status: "omitted",
    verdict: "omitted",
    exitCode: null,
    signal: null,
    durationMs: 0,
    executed: false,
    stdout: emptyChunk(),
    stderr: emptyChunk(),
    reason: "explicitly omitted",
  };
}

function outcomeStep(
  phase: VerifyPhase,
  resolved: ResolvedProjectCommand,
  outcome: ProjectCommandExecutionOutcome,
  elapsed: number,
  forcedTimeout: boolean,
  timeoutReason: "step timeout" | "aggregate timeout",
): VerifyStepResult {
  const failed = forcedTimeout || outcome.status !== "success" || outcome.exit.code !== 0;
  const step: VerifyStepResult = {
    phase,
    status: failed ? "failed" : "passed",
    verdict: failed ? "failed" : "passed",
    command: displayCommand(resolved),
    resolvedCommand: displayCommand(resolved),
    executable: resolved.executable,
    args: [...resolved.args],
    ...(resolved.scriptKey === undefined ? {} : { script: resolved.scriptKey }),
    exitCode: forcedTimeout ? null : outcome.exit.code,
    signal: forcedTimeout ? "SIGTERM" : outcome.exit.signal,
    durationMs: elapsed,
    executed: outcome.executed ?? true,
    stdout: outputChunk(outcome.stdout),
    stderr: outputChunk(outcome.stderr),
    ...(forcedTimeout
      ? { reason: timeoutReason }
      : outcome.status === "spawn-failure"
        ? { reason: "spawn failure" }
        : outcome.status === "cancelled"
          ? { reason: "cancelled" }
          : {}),
  };
  if (!failed) return step;
  const tailText = failureTail(step);
  return tailText === undefined ? step : { ...step, failureTail: tailText };
}

function aggregateVerdict(steps: readonly VerifyStepResult[]): "passed" | "failed" | "incomplete" {
  if (steps.some((step) => step.status === "failed" || step.status === "not-run")) return "failed";
  if (steps.some((step) => step.status === "omitted")) return "incomplete";
  return "passed";
}

function validTimeout(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function timeoutOutcome(): ProjectCommandExecutionOutcome {
  return {
    status: "timeout",
    exit: { code: null, signal: "SIGTERM" },
    timedOut: true,
    cancelled: false,
    executed: true,
    stdout: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
    stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
  };
}

function appendRemainingSteps(
  input: NormalizedVerifyInput,
  startIndex: number,
  reason: string,
  steps: VerifyStepResult[],
): void {
  for (let index = startIndex; index < VERIFY_PHASES.length; index += 1) {
    const phase = VERIFY_PHASES[index];
    steps.push(input.omit.includes(phase) ? omittedStep(phase) : notRunStep(phase, reason));
  }
}

function sessionId(ctx: VerifyToolContext): string {
  try {
    const value = ctx.sessionManager?.getSessionId();
    return typeof value === "string" && value.length > 0 ? value : "unknown-session";
  } catch {
    return "unknown-session";
  }
}

function retrySessionId(ctx: VerifyToolContext): string | undefined {
  try {
    const value = ctx.sessionManager?.getSessionId();
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

interface VerifyOutputSummary {
  readonly stdout: {
    readonly truncated: boolean;
    readonly totalBytes: number;
    readonly totalLines: number;
  };
  readonly stderr: {
    readonly truncated: boolean;
    readonly totalBytes: number;
    readonly totalLines: number;
  };
}

function verifyInvocationOutput(record: VerifyEvidenceRecord): VerifyOutputSummary {
  return record.perStep.reduce<VerifyOutputSummary>(
    (summary, step) => ({
      stdout: {
        truncated: summary.stdout.truncated || step.stdout.truncated,
        totalBytes: summary.stdout.totalBytes + step.stdout.totalBytes,
        totalLines: summary.stdout.totalLines + step.stdout.totalLines,
      },
      stderr: {
        truncated: summary.stderr.truncated || step.stderr.truncated,
        totalBytes: summary.stderr.totalBytes + step.stderr.totalBytes,
        totalLines: summary.stderr.totalLines + step.stderr.totalLines,
      },
    }),
    {
      stdout: { truncated: false, totalBytes: 0, totalLines: 0 },
      stderr: { truncated: false, totalBytes: 0, totalLines: 0 },
    },
  );
}

type VerifyInvocationRecord = Parameters<typeof recordProjectCommandInvocation>[1];

type VerifyInvocationMetadata = Pick<
  VerifyInvocationRecord,
  "sessionId" | "toolCallId" | "schemaHash" | "commandId"
>;

function verifyInvocationMetadata(
  ctx: VerifyToolContext,
  toolCallId: string,
): VerifyInvocationMetadata {
  return {
    sessionId: sessionId(ctx),
    toolCallId,
    schemaHash: hash(verifyInputSchema),
    commandId: "verify",
  };
}

function verifyInvocationDetails(
  input: NormalizedVerifyInput,
  prepared: readonly PreparedStep[],
): Pick<VerifyInvocationRecord, "redactedParameters" | "coercions"> {
  return {
    redactedParameters: {
      phases: prepared.map(({ phase }) => phase),
      coercions: input.coercions,
      ...(input.ref === undefined ? {} : { lookup: true, ref: input.ref }),
    },
    coercions: input.coercions,
  };
}

function verifyInvocationMutating(prepared: readonly PreparedStep[]): boolean {
  return prepared.some(({ phase, resolved }) =>
    projectCommandMutatesWorkspace(
      stepDefinition(phase, resolved.scriptKey ?? SCRIPT_BY_PHASE[phase]),
      resolved,
    ),
  );
}

function verifyInvocationLookup(
  lookup: ProjectCommandInvocationLookupMetadata | undefined,
): Pick<VerifyInvocationRecord, "lookup"> {
  return lookup === undefined ? {} : { lookup };
}

function verifyInvocationSuccess(
  input: NormalizedVerifyInput,
  startedAt: number,
  record: VerifyEvidenceRecord,
  reused: boolean,
  output: VerifyOutputSummary,
  executedCacheDecision: ProjectCommandCacheDecision | undefined,
): Pick<
  VerifyInvocationRecord,
  | "resultCategory"
  | "status"
  | "executed"
  | "reason"
  | "cacheDecision"
  | "forced"
  | "reused"
  | "durationMs"
  | "executionDurationMs"
  | "output"
  | "measurements"
  | "verdict"
> {
  const cacheDecision = input.fresh
    ? "forced"
    : reused
      ? "hit"
      : (executedCacheDecision ?? "ineligible");
  const reason =
    cacheDecision === "forced"
      ? "executed-forced-cache-bypass"
      : cacheDecision === "hit"
        ? "reused-cache-hit"
        : cacheDecision === "miss"
          ? "executed-after-cache-miss"
          : cacheDecision === "invalidated"
            ? "executed-after-cache-invalidation"
            : "executed-cache-ineligible";
  return {
    resultCategory: record.verdict === "passed" ? "PASS" : "IMPLEMENTATION_FAILURE",
    status: record.verdict === "failed" ? "nonzero" : "success",
    executed: !reused,
    reason,
    cacheDecision,
    forced: input.fresh,
    reused,
    durationMs: durationMs(startedAt),
    executionDurationMs: reused ? 0 : durationMs(startedAt),
    output,
    measurements: createProjectCommandInvocationMeasurements(cacheDecision, reused, output),
    verdict: record.verdict,
  };
}

function recordVerifyInvocation(
  recorder: ProjectCommandInvocationRecorder | undefined,
  ctx: VerifyToolContext,
  toolCallId: string,
  startedAt: number,
  input: NormalizedVerifyInput,
  prepared: readonly PreparedStep[],
  record: VerifyEvidenceRecord,
  reused: boolean,
  publication?: ProjectCommandInvocationPublicationMetadata,
  telemetry?: {
    readonly cacheDecision?: ProjectCommandCacheDecision;
    readonly concurrentExecutions?: number;
    readonly stateDrift?: boolean;
    readonly stateMatchesCurrent?: boolean;
    readonly sharedExecution?: boolean;
    readonly mutating?: boolean;
  },
  invocationRef?: string | null,
  lookup?: ProjectCommandInvocationLookupMetadata,
): void {
  const orchestration = readProjectCommandOrchestrationContext();
  const output = verifyInvocationOutput(record);
  recordProjectCommandInvocation(recorder, {
    ...verifyInvocationMetadata(ctx, toolCallId),
    ...verifyInvocationDetails(input, prepared),
    ...verifyInvocationSuccess(input, startedAt, record, reused, output, telemetry?.cacheDecision),
    ...orchestrationInvocationMetadata(
      orchestration,
      invocationRef === null ? record.ref : invocationRef,
    ),
    ...(record.repositoryState === undefined
      ? {}
      : {
          repositoryState: {
            ...record.repositoryState,
            readable: true,
            ...(telemetry?.stateMatchesCurrent === undefined
              ? {}
              : { stateMatchesCurrent: telemetry.stateMatchesCurrent }),
          },
        }),
    mutating: telemetry?.mutating ?? verifyInvocationMutating(prepared),
    ...(publication === undefined ? {} : { publication }),
    ...verifyInvocationLookup(lookup),
    ...(telemetry?.concurrentExecutions === undefined
      ? {}
      : { concurrentExecutions: telemetry.concurrentExecutions }),
    ...(telemetry?.stateDrift === undefined ? {} : { stateDrift: telemetry.stateDrift }),
    ...(telemetry?.sharedExecution === undefined
      ? {}
      : { sharedExecution: telemetry.sharedExecution }),
    aggregate: true,
  });
}

function orchestrationInvocationMetadata(
  orchestration: ReturnType<typeof readProjectCommandOrchestrationContext>,
  ref?: string,
): {
  readonly producerScope?: "session" | "flow";
  readonly flowId?: string;
  readonly delegationId?: string;
  readonly role?: string;
  readonly ref?: string;
} {
  return {
    ...(orchestration.orchestrated ? { producerScope: orchestration.effectiveScope } : {}),
    ...(orchestration.flowId === undefined ? {} : { flowId: orchestration.flowId }),
    ...(orchestration.delegationId === undefined
      ? {}
      : { delegationId: orchestration.delegationId }),
    ...(orchestration.role === undefined ? {} : { role: orchestration.role }),
    ...(ref === undefined ? {} : { ref }),
  };
}

function failureResultCategory(error: unknown): ResultCategory {
  const code = error instanceof VerifyToolError ? error.code : "implementation-failure";
  if (code === "invalid-request") return "INVALID_REQUEST";
  if (code === "not-found" || code.includes("resolution") || code.includes("repository-state")) {
    return "RESOLUTION_FAILURE";
  }
  if (code === "cancelled") return "CANCELLED";
  if (
    code.startsWith("policy-") ||
    code.includes("authorization") ||
    code === "publication-failure"
  ) {
    return "POLICY_FAILURE";
  }
  return "IMPLEMENTATION_FAILURE";
}

function failureReason(
  error: unknown,
  lookupAttempted: boolean,
  executionStarted: boolean,
): ProjectCommandInvocationReason {
  const code = error instanceof VerifyToolError ? error.code : "";
  if (code === "cancelled") return "cancelled";
  if (lookupAttempted) return "lookup-failure";
  if (code === "invalid-request") return "invalid-request";
  if (code === "not-found" || code.includes("resolution") || code.includes("repository-state")) {
    return "resolution-failure";
  }
  if (
    code.startsWith("policy-") ||
    code.includes("authorization") ||
    code === "publication-failure"
  ) {
    return "policy-failure";
  }
  return executionStarted ? "execution-failure" : "preparation-failure";
}

function rawVerifyParameter(rawParams: VerifyInput, key: keyof VerifyInput): unknown {
  if (typeof rawParams !== "object" || rawParams === null) return undefined;
  return rawParams[key];
}

function rawVerifyStringParameter(
  rawParams: VerifyInput,
  key: keyof VerifyInput,
): string | undefined {
  const value = rawVerifyParameter(rawParams, key);
  return typeof value === "string" ? value : undefined;
}

function verifyFailureInvocationDetails(
  startedAt: number,
  rawParams: VerifyInput,
  input: NormalizedVerifyInput | undefined,
  prepared: readonly PreparedStep[],
  error: unknown,
  executionStarted: boolean,
  ref: string | undefined,
): Omit<
  VerifyInvocationRecord,
  | "sessionId"
  | "toolCallId"
  | "schemaHash"
  | "commandId"
  | "producerScope"
  | "delegationId"
  | "role"
  | "ref"
> {
  const flowId = input?.flowId ?? rawVerifyStringParameter(rawParams, "flowId");
  const lookupAttempted = ref !== undefined;
  const lookupOutcome = lookupAttempted ? verifyLookupFailureOutcome(input, error) : undefined;
  const fresh = input?.fresh === true || rawVerifyParameter(rawParams, "fresh") === true;
  return {
    redactedParameters: {
      phases:
        prepared.length > 0
          ? prepared.map(({ phase }) => phase)
          : input === undefined
            ? []
            : VERIFY_PHASES.filter((phase) => !input.omit.includes(phase)),
      ...(ref === undefined ? {} : { lookup: true, ref }),
      ...(flowId === undefined ? {} : { flowId }),
    },
    resultCategory: failureResultCategory(error),
    executed: executionStarted,
    reason: failureReason(error, lookupAttempted, executionStarted),
    cacheDecision: fresh && executionStarted ? "forced" : "ineligible",
    forced: fresh && executionStarted,
    reused: false,
    durationMs: durationMs(startedAt),
    executionDurationMs: executionStarted ? durationMs(startedAt) : 0,
    output: {
      stdout: { truncated: false, totalBytes: 0, totalLines: 0 },
      stderr: { truncated: false, totalBytes: 0, totalLines: 0 },
    },
    ...verifyInvocationLookup(
      lookupAttempted
        ? {
            attempted: true,
            success: false,
            failure: error instanceof VerifyToolError ? error.code : "implementation-failure",
            ...(lookupOutcome === undefined ? {} : { outcome: lookupOutcome }),
          }
        : undefined,
    ),
    mutating: verifyInvocationMutating(prepared),
    aggregate: true,
  };
}

function recordVerifyFailureInvocation(
  recorder: ProjectCommandInvocationRecorder | undefined,
  ctx: VerifyToolContext,
  toolCallId: string,
  startedAt: number,
  rawParams: VerifyInput,
  input: NormalizedVerifyInput | undefined,
  prepared: readonly PreparedStep[],
  error: unknown,
  executionStarted: boolean,
): void {
  const ref = input?.ref ?? rawVerifyStringParameter(rawParams, "ref");
  recordProjectCommandInvocation(recorder, {
    ...verifyInvocationMetadata(ctx, toolCallId),
    ...verifyFailureInvocationDetails(
      startedAt,
      rawParams,
      input,
      prepared,
      error,
      executionStarted,
      ref,
    ),
    ...orchestrationInvocationMetadata(readProjectCommandOrchestrationContext(), ref),
  });
}

interface VerifyStepRunOptions {
  readonly input: NormalizedVerifyInput;
  readonly prepared: ReadonlyMap<VerifyPhase, PreparedStep>;
  readonly projectPath: string;
  readonly repositoryState: VerifyRepositoryState | undefined;
  readonly executor: ProjectCommandExecutor;
  readonly aggregateController: AbortController;
  readonly requestSignal: AbortSignal | undefined;
  readonly stepTimeoutMs: number;
  readonly isAggregateTimedOut: () => boolean;
  readonly steps: VerifyStepResult[];
  readonly telemetry: {
    sharedExecution: boolean;
    concurrentExecutions: number;
  };
}

function verifyStepSingleFlightKey(
  options: VerifyStepRunOptions,
  phase: VerifyPhase,
  step: PreparedStep,
): string | undefined {
  if (
    options.input.fresh ||
    projectCommandMutatesWorkspace(
      stepDefinition(phase, step.resolved.scriptKey ?? SCRIPT_BY_PHASE[phase]),
      step.resolved,
    )
  ) {
    return undefined;
  }
  return hash({
    projectPath: options.projectPath,
    repositoryState: options.repositoryState,
    phase,
    command: displayCommand(step.resolved),
    scriptFingerprint: scriptFingerprint(step.resolved),
  });
}

interface VerifyStepExecution {
  readonly outcome: ProjectCommandExecutionOutcome;
  readonly stepTimedOut: boolean;
  readonly startedAt: number;
}

interface VerifyStepAbortScope {
  readonly controller: AbortController;
  readonly timedOut: () => boolean;
  cleanup(): void;
}

function createVerifyStepAbortScope(options: VerifyStepRunOptions): VerifyStepAbortScope {
  const controller = new AbortController();
  const abortStep = () => controller.abort();
  options.aggregateController.signal.addEventListener("abort", abortStep, { once: true });
  let stepTimedOut = false;
  const stepTimer = setTimeout(() => {
    stepTimedOut = true;
    controller.abort();
  }, options.stepTimeoutMs);
  return {
    controller,
    timedOut: () => stepTimedOut,
    cleanup() {
      clearTimeout(stepTimer);
      options.aggregateController.signal.removeEventListener("abort", abortStep);
    },
  };
}

interface VerifyStepExecutionHandle {
  readonly promise: Promise<ProjectCommandExecutionOutcome>;
  readonly sharedExecution: boolean;
  release(): void;
}

function settleVerifyStepSingleFlight(key: string, flight: VerifyStepSingleFlight): void {
  flight.settled = true;
  if (VERIFY_STEP_SINGLE_FLIGHTS.get(key) === flight) {
    VERIFY_STEP_SINGLE_FLIGHTS.delete(key);
  }
}

function releaseVerifyStepSingleFlight(key: string, flight: VerifyStepSingleFlight): void {
  flight.active -= 1;
  if (flight.active !== 0) return;
  if (!flight.settled) flight.controller.abort();
  settleVerifyStepSingleFlight(key, flight);
}

function startVerifyStepExecution(
  options: VerifyStepRunOptions,
  step: PreparedStep,
  singleFlightKey: string | undefined,
  stepController: AbortController,
): VerifyStepExecutionHandle {
  if (singleFlightKey === undefined) {
    return {
      promise: options.executor(step.resolved, options.projectPath, stepController.signal),
      sharedExecution: false,
      release: () => {},
    };
  }

  const existing = VERIFY_STEP_SINGLE_FLIGHTS.get(singleFlightKey);
  if (existing !== undefined) {
    existing.active += 1;
    options.telemetry.concurrentExecutions = Math.max(
      options.telemetry.concurrentExecutions,
      existing.active,
    );
    return {
      promise: existing.promise,
      sharedExecution: true,
      release: () => releaseVerifyStepSingleFlight(singleFlightKey, existing),
    };
  }

  const controller = new AbortController();
  const created: VerifyStepSingleFlight = {
    promise: Promise.resolve().then(() =>
      options.executor(step.resolved, options.projectPath, controller.signal),
    ),
    controller,
    active: 1,
    settled: false,
  };
  VERIFY_STEP_SINGLE_FLIGHTS.set(singleFlightKey, created);
  void created.promise.then(
    () => settleVerifyStepSingleFlight(singleFlightKey, created),
    () => settleVerifyStepSingleFlight(singleFlightKey, created),
  );
  options.telemetry.concurrentExecutions = Math.max(options.telemetry.concurrentExecutions, 1);
  return {
    promise: created.promise,
    sharedExecution: false,
    release: () => releaseVerifyStepSingleFlight(singleFlightKey, created),
  };
}

async function executeVerifyStep(
  options: VerifyStepRunOptions,
  phase: VerifyPhase,
  step: PreparedStep,
): Promise<VerifyStepExecution> {
  const abortScope = createVerifyStepAbortScope(options);
  const startedAt = performance.now();
  const singleFlightKey = verifyStepSingleFlightKey(options, phase, step);
  let outcome: ProjectCommandExecutionOutcome;
  let execution: VerifyStepExecutionHandle | undefined;
  try {
    execution = startVerifyStepExecution(options, step, singleFlightKey, abortScope.controller);
    outcome = await awaitWithAbort(
      execution.promise,
      abortScope.controller.signal,
      () => new VerifyToolError("cancelled", "verify was cancelled"),
    );
    if (execution.sharedExecution) options.telemetry.sharedExecution = true;
  } catch {
    if (options.requestSignal?.aborted && !options.isAggregateTimedOut()) {
      throw new VerifyToolError("cancelled", "verify was cancelled");
    }
    if (abortScope.timedOut() || options.isAggregateTimedOut()) {
      outcome = timeoutOutcome();
    } else {
      throw new VerifyToolError("executor-failure", `verify ${phase} execution failed`);
    }
  } finally {
    abortScope.cleanup();
    execution?.release();
  }
  return { outcome, stepTimedOut: abortScope.timedOut(), startedAt };
}

async function runVerifySteps(options: VerifyStepRunOptions, index = 0): Promise<void> {
  if (index >= VERIFY_PHASES.length) return;
  const phase = VERIFY_PHASES[index];
  if (options.requestSignal?.aborted) {
    throw new VerifyToolError("cancelled", "verify was cancelled");
  }
  if (options.input.omit.includes(phase)) {
    options.steps.push(omittedStep(phase));
    return runVerifySteps(options, index + 1);
  }
  if (options.isAggregateTimedOut()) {
    appendRemainingSteps(options.input, index, "stopped after aggregate timeout", options.steps);
    return;
  }
  const step = options.prepared.get(phase);
  if (step === undefined) {
    options.steps.push(notRunStep(phase, "phase was not resolved"));
    appendRemainingSteps(options.input, index + 1, "stopped after unresolved phase", options.steps);
    return;
  }
  const execution = await executeVerifyStep(options, phase, step);
  const { outcome, stepTimedOut, startedAt } = execution;
  if (options.requestSignal?.aborted && !options.isAggregateTimedOut()) {
    throw new VerifyToolError("cancelled", "verify was cancelled");
  }
  const stepResult = outcomeStep(
    phase,
    step.resolved,
    outcome,
    durationMs(startedAt),
    stepTimedOut || options.isAggregateTimedOut(),
    options.isAggregateTimedOut() ? "aggregate timeout" : "step timeout",
  );
  options.steps.push(stepResult);
  if (options.isAggregateTimedOut()) {
    appendRemainingSteps(
      options.input,
      index + 1,
      "stopped after aggregate timeout",
      options.steps,
    );
    return;
  }
  if (stepResult.status === "failed" && !options.input.continueOnFailure) {
    appendRemainingSteps(options.input, index + 1, "stopped after earlier failure", options.steps);
    return;
  }
  return runVerifySteps(options, index + 1);
}

function publishVerifyEvidence(options: {
  readonly cache: VerifyEvidenceCache;
  readonly record: VerifyEvidenceRecord;
  readonly input: NormalizedVerifyInput;
  readonly state: VerifyRepositoryState | undefined;
  readonly finalState: VerifyRepositoryState | undefined;
  readonly stableForCache: boolean;
}): {
  readonly outputRecord: VerifyEvidenceRecord;
  readonly publication: ProjectCommandInvocationPublicationMetadata | undefined;
} {
  if (options.input.publish === undefined) {
    return { outputRecord: options.record, publication: undefined };
  }
  if (!options.stableForCache || options.state === undefined || options.finalState === undefined) {
    throw new VerifyToolError(
      "publication-failure",
      `verify could not publish ${options.record.ref}: repository state is unreadable or changed during execution; rerun with a readable, stable repository`,
    );
  }
  if (options.state.repositoryIdentity !== options.finalState.repositoryIdentity) {
    throw new VerifyToolError(
      "publication-failure",
      `verify could not publish ${options.record.ref}: repository identity changed from ${options.state.repositoryIdentity} to ${options.finalState.repositoryIdentity}`,
    );
  }
  const published = options.cache.publish?.(
    options.record.ref,
    options.input.publish.flowId,
    options.finalState.repositoryIdentity,
  );
  if (published === undefined) {
    throw new VerifyToolError(
      "publication-failure",
      `verify could not publish ${options.record.ref} to flow ${options.input.publish.flowId}: no compatible stable evidence was stored`,
    );
  }
  return {
    outputRecord: published,
    publication: {
      scope: "flow",
      flowId: options.input.publish.flowId,
      published: true,
    },
  };
}

function createVerifyEvidenceRecord(options: {
  readonly key: string;
  readonly ref: string;
  readonly projectPath: string;
  readonly state: VerifyRepositoryState | undefined;
  readonly prepared: readonly PreparedStep[];
  readonly resolvedCommands: readonly string[];
  readonly steps: readonly VerifyStepResult[];
  readonly input: NormalizedVerifyInput;
  readonly orchestration: ReturnType<typeof readProjectCommandOrchestrationContext>;
  readonly telemetry: {
    readonly concurrentExecutions: number;
    readonly sharedExecution: boolean;
  };
  readonly stateDrift: boolean;
}): VerifyEvidenceRecord {
  const firstFailure = options.steps.find((step) => step.status === "failed");
  const verdict = aggregateVerdict(options.steps);
  return {
    cacheFormatVersion: VERIFY_CACHE_FORMAT_VERSION,
    key: options.key,
    ref: options.ref,
    producer: EVIDENCE_PRODUCER,
    kind: "verify" as const,
    requestHash: sharedEvidenceRequestHash({
      projectPath: options.projectPath,
      commands: options.prepared.map(({ phase, resolved }) => ({
        phase,
        executable: resolved.executable,
        args: [...resolved.args],
        displayCommand: displayCommand(resolved),
        scriptKey: resolved.scriptKey,
        scriptFingerprint: scriptFingerprint(resolved),
      })),
      paths: options.input.paths,
      omit: options.input.omit,
      scripts: options.input.scripts,
      continueOnFailure: options.input.continueOnFailure,
      covers: options.input.covers,
    }),
    contentHash: sharedEvidenceContentHash({
      resolvedCommands: options.resolvedCommands,
      perStep: options.steps,
      verdict,
      ...(firstFailure?.failureTail === undefined ? {} : { failureTail: firstFailure.failureTail }),
    }),
    ...(options.state === undefined
      ? {}
      : {
          workspace: sharedWorkspaceBlock({
            repositoryIdentity: options.state.repositoryIdentity,
            head: options.state.head,
            dirtyFilesDigest: options.state.dirtyFilesDigest,
          }),
        }),
    output: aggregateSharedEvidenceOutput([
      ...options.steps.map((step) => step.stdout),
      ...options.steps.map((step) => step.stderr),
    ]),
    projectPath: options.projectPath,
    ...(options.state === undefined ? {} : { repositoryState: options.state }),
    resolvedCommands: options.resolvedCommands,
    perStep: options.steps,
    verdict,
    ...(firstFailure?.failureTail === undefined ? {} : { failureTail: firstFailure.failureTail }),
    covers: options.input.covers,
    createdAt: Date.now(),
    provenance: {
      scope: options.orchestration.effectiveScope === "flow" ? "flow" : "root",
      ...(options.orchestration.flowId === undefined
        ? {}
        : { flowId: options.orchestration.flowId }),
      ...(options.state === undefined
        ? {}
        : { repositoryIdentity: options.state.repositoryIdentity }),
    },
    mutating: options.prepared.some(({ phase, resolved }) =>
      projectCommandMutatesWorkspace(
        stepDefinition(phase, resolved.scriptKey ?? SCRIPT_BY_PHASE[phase]),
        resolved,
      ),
    ),
    concurrentExecutions: Math.max(1, options.telemetry.concurrentExecutions),
    stateDrift: options.stateDrift,
    sharedExecution: options.telemetry.sharedExecution,
  };
}

interface VerifyRepositoryStateReconciliation {
  readonly finalState: VerifyRepositoryState | undefined;
  readonly stableForCache: boolean;
  readonly stateDrift: boolean;
  readonly stateMatchesCurrent: boolean | undefined;
}

async function reconcileVerifyRepositoryState(options: {
  readonly repositoryStateReader: ProjectCommandRepositoryStateReader | undefined;
  readonly projectPath: string;
  readonly requestSignal: AbortSignal | undefined;
  readonly initialState: VerifyRepositoryState | undefined;
  readonly prepared: readonly PreparedStep[];
  readonly input: NormalizedVerifyInput;
  readonly key: string;
  readonly repositoryStateReliable: boolean;
}): Promise<VerifyRepositoryStateReconciliation> {
  if (options.repositoryStateReader === undefined) {
    return {
      finalState: options.initialState,
      stableForCache: options.repositoryStateReliable,
      stateDrift: false,
      stateMatchesCurrent: undefined,
    };
  }
  try {
    const finalState = await readVerifyRepositoryState(
      options.repositoryStateReader,
      options.projectPath,
      options.requestSignal,
    );
    const stableForCache =
      options.initialState !== undefined &&
      finalState !== undefined &&
      cacheKey(options.projectPath, finalState, options.prepared, options.input) === options.key;
    const stateMatchesCurrent =
      options.initialState === undefined || finalState === undefined
        ? undefined
        : repositoryStateMatches(options.initialState, finalState) === "matches";
    return {
      finalState,
      stableForCache,
      stateDrift: stateMatchesCurrent === false,
      stateMatchesCurrent,
    };
  } catch (error) {
    if (error instanceof VerifyToolError && error.code === "cancelled") throw error;
    return {
      finalState: undefined,
      stableForCache: false,
      stateDrift: false,
      stateMatchesCurrent: undefined,
    };
  }
}

interface StableVerifyCacheLookup {
  readonly cached?: VerifyEvidenceRecord;
  readonly key: string;
  readonly state?: VerifyRepositoryState;
  readonly repositoryStateReliable: boolean;
}

async function stableVerifyCacheLookup(options: {
  readonly cache: VerifyEvidenceCache;
  readonly repositoryStateReader: ProjectCommandRepositoryStateReader | undefined;
  readonly projectPath: string;
  readonly prepared: readonly PreparedStep[];
  readonly input: NormalizedVerifyInput;
  readonly signal: AbortSignal | undefined;
  readonly state: VerifyRepositoryState | undefined;
  readonly key: string;
}): Promise<StableVerifyCacheLookup | undefined> {
  if (
    options.input.fresh ||
    options.input.publish !== undefined ||
    options.state === undefined ||
    options.repositoryStateReader === undefined
  ) {
    return undefined;
  }
  const cached = options.cache.get(options.key);
  if (cached === undefined) return undefined;
  let stableState: VerifyRepositoryState | undefined;
  try {
    stableState = await readVerifyRepositoryState(
      options.repositoryStateReader,
      options.projectPath,
      options.signal,
    );
  } catch (error) {
    if (error instanceof VerifyToolError && error.code === "cancelled") throw error;
  }
  const stableKey = cacheKey(options.projectPath, stableState, options.prepared, options.input);
  if (stableState !== undefined && stableKey === options.key) {
    return {
      cached,
      key: options.key,
      state: stableState,
      repositoryStateReliable: true,
    };
  }
  return {
    key: stableKey,
    state: stableState,
    repositoryStateReliable: stableState !== undefined,
  };
}

function verifyLookupFailureOutcome(
  input: NormalizedVerifyInput | undefined,
  error: unknown,
): ProjectCommandInvocationLookupOutcome | undefined {
  if (input === undefined) return undefined;
  const orchestration = readProjectCommandOrchestrationContext();
  if (
    input.flowId !== undefined &&
    (orchestration.effectiveScope !== "flow" || orchestration.flowId !== input.flowId)
  ) {
    return projectCommandInvocationLookupOutcome("unauthorized-flow");
  }
  return error instanceof VerifyToolError && error.code === "not-found"
    ? projectCommandInvocationLookupOutcome("not-found")
    : undefined;
}

function verifyLookupNotFoundError(
  input: NormalizedVerifyInput,
  orchestration: ReturnType<typeof readProjectCommandOrchestrationContext>,
): VerifyToolError {
  const bucket =
    input.flowId !== undefined
      ? `the effective flow scope ${input.flowId}`
      : orchestration.effectiveScope === "flow" && orchestration.flowId !== undefined
        ? `the effective flow scope ${orchestration.flowId}`
        : "the process-local root-session cache";
  const guidance =
    input.flowId !== undefined &&
    (orchestration.effectiveScope !== "flow" || orchestration.flowId !== input.flowId)
      ? "A flow lookup requires the same effective flow scope; environment variables alone do not authorize a lookup."
      : bucket === "the process-local root-session cache"
        ? "Root-session refs are process-scoped and are not durable across processes."
        : "Only refs from the current effective flow are searchable.";
  return new VerifyToolError("not-found", `validation ref not found in ${bucket}. ${guidance}`);
}

interface VerifyToolDependencies {
  readonly policy: PolicyStore;
  readonly executor: ProjectCommandExecutor;
  readonly resolver: ProjectCommandResolver;
  readonly repositoryStateReader: ProjectCommandRepositoryStateReader | undefined;
  readonly authorizationOutcomeRecorder?: AuthorizationOutcomeRecorder;
  readonly authorizationRetryTracker?: AuthorizationRetryTracker;
  readonly cache: VerifyEvidenceCache;
  readonly aggregateTimeoutMs: number;
  readonly stepTimeoutMs: number;
  readonly invocationRecorder?: ProjectCommandInvocationRecorder;
}

interface VerifyRequest {
  readonly toolCallId: string;
  readonly rawParams: VerifyInput;
  readonly signal: AbortSignal | undefined;
  readonly ctx: VerifyToolContext;
}

type VerifyInvocationRecorder = (...args: Parameters<typeof recordVerifyInvocation>) => void;

interface VerifyPreparationOptions {
  readonly dependencies: VerifyToolDependencies;
  readonly input: NormalizedVerifyInput;
  readonly requestSignal: AbortSignal | undefined;
  readonly ctx: VerifyToolContext;
  readonly toolCallId: string;
  readonly invocationStartedAt: number;
  readonly recordInvocation: VerifyInvocationRecorder;
  readonly onPrepared: (prepared: readonly PreparedStep[]) => void;
}

interface VerifyPreparedExecution {
  readonly projectPath: string;
  readonly prepared: readonly PreparedStep[];
  readonly resolvedCommands: readonly string[];
  readonly state: VerifyRepositoryState | undefined;
  readonly repositoryStateReliable: boolean;
  readonly key: string;
  readonly ref: string;
}

type VerifyPreparationResult =
  | { readonly cached: AgentToolResult<VerifyOutput> }
  | { readonly prepared: VerifyPreparedExecution };

async function lookupVerifyEvidence(options: {
  readonly dependencies: VerifyToolDependencies;
  readonly input: NormalizedVerifyInput;
  readonly requestSignal: AbortSignal | undefined;
  readonly ctx: VerifyToolContext;
  readonly toolCallId: string;
  readonly invocationStartedAt: number;
  readonly recordInvocation: VerifyInvocationRecorder;
}): Promise<AgentToolResult<VerifyOutput> | undefined> {
  const { dependencies, input, requestSignal, ctx, toolCallId, invocationStartedAt } = options;
  if (input.ref === undefined) return undefined;
  const orchestration = readProjectCommandOrchestrationContext();
  if (
    input.flowId !== undefined &&
    (orchestration.effectiveScope !== "flow" || orchestration.flowId !== input.flowId)
  ) {
    throw new VerifyToolError(
      "not-found",
      `validation ref not found in the effective flow scope ${input.flowId}. A flow lookup requires the same effective flow scope; environment variables alone do not authorize a lookup.`,
    );
  }
  const record = dependencies.cache.getByRef(input.ref, input.flowId);
  if (record === undefined) throw verifyLookupNotFoundError(input, orchestration);
  let currentRepositoryState: VerifyRepositoryState | undefined;
  if (dependencies.repositoryStateReader !== undefined) {
    try {
      currentRepositoryState = await readVerifyRepositoryState(
        dependencies.repositoryStateReader,
        record.projectPath,
        requestSignal,
      );
    } catch (error) {
      if (error instanceof VerifyToolError && error.code === "cancelled") throw error;
    }
  }
  const lookupStateStatus = repositoryStateMatches(record.repositoryState, currentRepositoryState);
  options.recordInvocation(
    dependencies.invocationRecorder,
    ctx,
    toolCallId,
    invocationStartedAt,
    input,
    [],
    record,
    true,
    undefined,
    {
      concurrentExecutions: record.concurrentExecutions,
      stateDrift: record.stateDrift,
      stateMatchesCurrent:
        lookupStateStatus === "unreadable" ? undefined : lookupStateStatus === "matches",
      sharedExecution: record.sharedExecution,
      mutating: record.mutating,
    },
    null,
    {
      attempted: true,
      success: true,
      outcome: projectCommandInvocationLookupOutcome("success"),
    },
  );
  return result(fullOutput(record, currentRepositoryState));
}

async function prepareVerifyExecution(
  options: VerifyPreparationOptions,
): Promise<VerifyPreparationResult> {
  const {
    dependencies,
    input,
    requestSignal,
    ctx,
    toolCallId,
    invocationStartedAt,
    recordInvocation,
  } = options;
  const observe = createAuthorizationOutcomeObserver({
    surface: "verify",
    commandId: "verify",
    recorder: dependencies.authorizationOutcomeRecorder,
    sessionId: retrySessionId(ctx),
    toolCallId,
    mode: ctx.mode,
    flowId: effectiveOrchestrationFlowId(readProjectCommandOrchestrationContext()),
  });
  let loadedPolicy;
  try {
    loadedPolicy = await dependencies.policy.load(ctx.cwd);
  } catch {
    observe?.({
      outcome: "policy-load-failure",
      decisionPersisted: false,
      promptEmitted: false,
      promptWaitMs: 0,
    });
    throw new VerifyToolError("policy-load-failure", "verify policy could not be loaded");
  }
  const prepared = await resolveSteps(
    input,
    loadedPolicy.projectPath,
    dependencies.resolver,
    requestSignal,
  );
  options.onPrepared(prepared);
  const stateBeforeAuthorization =
    dependencies.repositoryStateReader === undefined
      ? undefined
      : await readVerifyRepositoryState(
          dependencies.repositoryStateReader,
          loadedPolicy.projectPath,
          requestSignal,
        );
  const resolvedCommands = prepared.map(({ resolved }) => displayCommand(resolved));
  const authorizationCommands = prepared.map(
    ({ phase, resolved }) =>
      `${phase}: ${displayCommand(resolved)} [script-sha256:${scriptFingerprint(resolved)}]`,
  );
  const identity = verificationIdentity(prepared, input);
  await authorizeVerify(
    dependencies.policy,
    ctx,
    requestSignal,
    identity,
    authorizationCommands,
    observe,
    dependencies.authorizationRetryTracker,
  );
  if (requestSignal?.aborted) throw new VerifyToolError("cancelled", "verify was cancelled");
  let state = stateBeforeAuthorization;
  let repositoryStateReliable = dependencies.repositoryStateReader === undefined;
  if (dependencies.repositoryStateReader !== undefined) {
    try {
      state = await readVerifyRepositoryState(
        dependencies.repositoryStateReader,
        loadedPolicy.projectPath,
        requestSignal,
      );
      repositoryStateReliable = state !== undefined;
    } catch (error) {
      if (error instanceof VerifyToolError && error.code === "cancelled") throw error;
      state = undefined;
      repositoryStateReliable = false;
    }
  }
  let key = cacheKey(loadedPolicy.projectPath, state, prepared, input);
  const cacheLookup = await stableVerifyCacheLookup({
    cache: dependencies.cache,
    repositoryStateReader: dependencies.repositoryStateReader,
    projectPath: loadedPolicy.projectPath,
    prepared,
    input,
    signal: requestSignal,
    state,
    key,
  });
  if (cacheLookup !== undefined) {
    state = cacheLookup.state;
    key = cacheLookup.key;
    repositoryStateReliable = cacheLookup.repositoryStateReliable;
    if (cacheLookup.cached !== undefined && cacheLookup.state !== undefined) {
      recordInvocation(
        dependencies.invocationRecorder,
        ctx,
        toolCallId,
        invocationStartedAt,
        input,
        prepared,
        cacheLookup.cached,
        true,
        undefined,
        { stateMatchesCurrent: true },
        null,
      );
      return { cached: result(compactOutput(cacheLookup.cached, cacheLookup.state)) };
    }
  }
  return {
    prepared: {
      projectPath: loadedPolicy.projectPath,
      prepared,
      resolvedCommands,
      state,
      repositoryStateReliable,
      key,
      ref: `vr_${key.slice(0, 24)}`,
    },
  };
}

async function executePreparedVerify(options: {
  readonly dependencies: VerifyToolDependencies;
  readonly input: NormalizedVerifyInput;
  readonly requestSignal: AbortSignal | undefined;
  readonly invocationStartedAt: number;
  readonly ctx: VerifyToolContext;
  readonly toolCallId: string;
  readonly prepared: VerifyPreparedExecution;
  readonly recordInvocation: VerifyInvocationRecorder;
  readonly onExecutionStarted: () => void;
}): Promise<AgentToolResult<VerifyOutput>> {
  const { dependencies, input, requestSignal, invocationStartedAt, ctx, toolCallId } = options;
  const { projectPath, prepared, resolvedCommands, state, repositoryStateReliable, key, ref } =
    options.prepared;
  const aggregateController = new AbortController();
  const abortAggregate = () => aggregateController.abort();
  requestSignal?.addEventListener("abort", abortAggregate, { once: true });
  let aggregateTimedOut = false;
  const aggregateTimer = setTimeout(() => {
    aggregateTimedOut = true;
    aggregateController.abort();
  }, dependencies.aggregateTimeoutMs);
  const byPhase = new Map<VerifyPhase, PreparedStep>(prepared.map((step) => [step.phase, step]));
  const steps: VerifyStepResult[] = [];
  const verifyStepTelemetry = {
    sharedExecution: false,
    concurrentExecutions: 1,
  };
  options.onExecutionStarted();
  try {
    await runVerifySteps({
      input,
      prepared: byPhase,
      projectPath,
      repositoryState: state,
      executor: dependencies.executor,
      aggregateController,
      requestSignal,
      stepTimeoutMs: dependencies.stepTimeoutMs,
      isAggregateTimedOut: () => aggregateTimedOut,
      steps,
      telemetry: verifyStepTelemetry,
    });
  } finally {
    clearTimeout(aggregateTimer);
    requestSignal?.removeEventListener("abort", abortAggregate);
  }
  steps.sort(
    (left, right) => VERIFY_PHASES.indexOf(left.phase) - VERIFY_PHASES.indexOf(right.phase),
  );
  const orchestration = readProjectCommandOrchestrationContext();
  const reconciliation = await reconcileVerifyRepositoryState({
    repositoryStateReader: dependencies.repositoryStateReader,
    projectPath,
    requestSignal,
    initialState: state,
    prepared,
    input,
    key,
    repositoryStateReliable,
  });
  const { finalState, stableForCache, stateDrift, stateMatchesCurrent } = reconciliation;
  const record = createVerifyEvidenceRecord({
    key,
    ref,
    projectPath,
    state,
    prepared,
    resolvedCommands,
    steps,
    input,
    orchestration,
    telemetry: verifyStepTelemetry,
    stateDrift,
  });
  if (stableForCache && !verifyStepTelemetry.sharedExecution) dependencies.cache.set(record);
  const { outputRecord, publication } = publishVerifyEvidence({
    cache: dependencies.cache,
    record,
    input,
    state,
    finalState,
    stableForCache,
  });
  options.recordInvocation(
    dependencies.invocationRecorder,
    ctx,
    toolCallId,
    invocationStartedAt,
    input,
    prepared,
    outputRecord,
    false,
    publication,
    {
      cacheDecision: input.fresh ? "forced" : stableForCache ? "miss" : "ineligible",
      concurrentExecutions: record.concurrentExecutions,
      stateDrift: record.stateDrift,
      stateMatchesCurrent,
      sharedExecution: record.sharedExecution,
      mutating: record.mutating,
    },
    stableForCache ? outputRecord.ref : undefined,
  );
  return result(
    completedOutput(outputRecord, false, stableForCache ? outputRecord.ref : undefined, finalState),
  );
}

async function executeVerifyRequest(
  dependencies: VerifyToolDependencies,
  request: VerifyRequest,
): Promise<AgentToolResult<VerifyOutput>> {
  const { toolCallId, rawParams, signal, ctx } = request;
  const invocationStartedAt = performance.now();
  let input: NormalizedVerifyInput | undefined;
  let preparedForInvocation: readonly PreparedStep[] = [];
  let invocationRecorded = false;
  let executionStarted = false;
  const recordInvocation: VerifyInvocationRecorder = (...args) => {
    if (invocationRecorded) return;
    invocationRecorded = true;
    recordVerifyInvocation(...args);
  };
  try {
    input = validateVerifyInput(rawParams);
    const requestSignal = signal ?? ctx.signal;
    if (requestSignal?.aborted) throw new VerifyToolError("cancelled", "verify was cancelled");
    const lookup = await lookupVerifyEvidence({
      dependencies,
      input,
      requestSignal,
      ctx,
      toolCallId,
      invocationStartedAt,
      recordInvocation,
    });
    if (lookup !== undefined) return lookup;
    if (requestSignal?.aborted) throw new VerifyToolError("cancelled", "verify was cancelled");
    const preparation = await prepareVerifyExecution({
      dependencies,
      input,
      requestSignal,
      ctx,
      toolCallId,
      invocationStartedAt,
      recordInvocation,
      onPrepared: (prepared) => {
        preparedForInvocation = prepared;
      },
    });
    if ("cached" in preparation) return preparation.cached;
    return await executePreparedVerify({
      dependencies,
      input,
      requestSignal,
      invocationStartedAt,
      ctx,
      toolCallId,
      prepared: preparation.prepared,
      recordInvocation,
      onExecutionStarted: () => {
        executionStarted = true;
      },
    });
  } catch (error) {
    if (!invocationRecorded) {
      invocationRecorded = true;
      recordVerifyFailureInvocation(
        dependencies.invocationRecorder,
        ctx,
        toolCallId,
        invocationStartedAt,
        rawParams,
        input,
        preparedForInvocation,
        error,
        executionStarted,
      );
    }
    throw error;
  }
}

function createVerifyToolWithDependencies(
  policy: PolicyStore,
  executor: ProjectCommandExecutor,
  resolver: ProjectCommandResolver,
  repositoryStateReader: ProjectCommandRepositoryStateReader | undefined,
  cache: VerifyEvidenceCache,
  aggregateTimeoutMs: number,
  stepTimeoutMs: number,
  invocationRecorder?: ProjectCommandInvocationRecorder,
  authorizationOutcomeRecorder?: AuthorizationOutcomeRecorder,
  authorizationRetryTracker?: AuthorizationRetryTracker,
): VerifyToolDefinition {
  return {
    name: "verify",
    label: "Verify",
    description:
      "Run package-script format, lint, typecheck, and test phases in fixed order with bounded validation evidence and stable lookup references. Use fresh: true to rerun without changing the evidence key, and use ref with optional flowId only for lookup without execution. Executing requests may include covers and publish: { flowId }. Root-session refs are process-scoped; flow refs are durable only within an authorized flow.",
    promptSnippet: "Run fixed-order project verification",
    parameters: verifyInputSchema,
    executionMode: "sequential",
    renderCall(_args, theme) {
      return renderCallLine(theme, "verify", []);
    },
    async execute(
      toolCallId,
      rawParams,
      signal,
      _onUpdate: AgentToolUpdateCallback<VerifyOutput> | undefined,
      ctx,
    ) {
      return executeVerifyRequest(
        {
          policy,
          executor,
          resolver,
          repositoryStateReader,
          cache,
          aggregateTimeoutMs,
          stepTimeoutMs,
          invocationRecorder,
          authorizationOutcomeRecorder,
          authorizationRetryTracker,
        },
        { toolCallId, rawParams, signal, ctx },
      );
    },
  };
}

export function createVerifyTool(
  exec: GitExec,
  options: VerifyToolOptions = {},
): VerifyToolDefinition {
  return createVerifyToolWithDependencies(
    options.policy ?? createPolicyStore(),
    options.executor ?? createProjectCommandExecutor(),
    options.resolver ?? resolveProjectCommand,
    options.repositoryStateReader ?? createProjectCommandRepositoryStateReader(exec),
    options.cache ?? createVerifyEvidenceCache(),
    validTimeout(options.aggregateTimeoutMs, DEFAULT_AGGREGATE_TIMEOUT_MS),
    validTimeout(options.stepTimeoutMs, DEFAULT_STEP_TIMEOUT_MS),
    options.invocationRecorder,
    options.authorizationOutcomeRecorder,
    options.authorizationRetryTracker,
  );
}

export function createVerifyToolForTesting(options: VerifyToolOptions): VerifyToolDefinition {
  let policy = options.policy;
  if (policy === undefined) {
    if (options.configPath === undefined) {
      throw new VerifyToolError(
        "invalid-request",
        "a policy or config path is required for testing",
      );
    }
    policy = createPolicyStoreForTesting({ configPath: options.configPath, fs: options.fs });
  }
  return createVerifyToolWithDependencies(
    policy,
    options.executor ?? createProjectCommandExecutor(),
    options.resolver ?? resolveProjectCommand,
    options.repositoryStateReader,
    options.cache ?? createVerifyEvidenceCache(),
    validTimeout(options.aggregateTimeoutMs, DEFAULT_AGGREGATE_TIMEOUT_MS),
    validTimeout(options.stepTimeoutMs, DEFAULT_STEP_TIMEOUT_MS),
    options.invocationRecorder,
    options.authorizationOutcomeRecorder,
    options.authorizationRetryTracker,
  );
}
