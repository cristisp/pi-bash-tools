import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { renderCallLine } from "../call-render.ts";
import { authorizeOrPrompt, type AuthorizationErrorKind } from "../authorization.ts";
import { createPolicyStore, createPolicyStoreForTesting } from "../policy/store.ts";
import type { PolicyFileSystem, PolicyStore } from "../policy/types.ts";
import { findProjectCommandPolicyDecision } from "../policy/decisions.ts";
import {
  getProjectCommandDefinition,
  type ProjectCommandDefinition,
} from "../project-command/definitions.ts";
import { createProjectCommandExecutor } from "../project-command/execution.ts";
import { readProjectCommandOrchestrationContext } from "../project-command/orchestration.ts";
import { projectCommandMutatesWorkspace } from "../project-command/mutability.ts";
import {
  createProjectCommandInvocationMeasurements,
  recordProjectCommandInvocation,
  type ProjectCommandInvocationPublicationMetadata,
  type ProjectCommandInvocationRecorder,
} from "../../observability/project-command-invocation.ts";
import type { ProjectCommandExecutor } from "../project-command/runner.ts";
import type { ProjectCommandExecutionOutcome } from "../project-command/execution.ts";
import {
  resolveProjectCommand,
  type ProjectCommandResolver,
  type ResolvedProjectCommand,
} from "../project-command/resolution.ts";
import { createProjectCommandRepositoryStateReader } from "../project-command/repository-state.ts";
import type { ProjectCommandRepositoryStateReader } from "../project-command/repository-state.ts";
import type { GitExec } from "../git/execution.ts";
import { createVerifyEvidenceCache, type VerifyEvidenceCache } from "./cache.ts";
import {
  validateVerifyInput,
  verifyInputSchema,
  VerifyToolError,
  type NormalizedVerifyInput,
  type VerifyInput,
} from "./schema.ts";
import {
  VERIFY_CACHE_FORMAT_VERSION,
  VERIFY_PHASES,
  type VerifyEvidenceRecord,
  type VerifyOutput,
  type VerifyOutputChunk,
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
const MAX_FAILURE_TAIL = 8 * 1024;

interface VerifyStepSingleFlight {
  readonly promise: Promise<ProjectCommandExecutionOutcome>;
  active: number;
}

const VERIFY_STEP_SINGLE_FLIGHTS = new Map<string, VerifyStepSingleFlight>();

function awaitVerifyStep<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new VerifyToolError("cancelled", "verify was cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

const ANSI_SGR_PATTERN = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;]*m`, "gu");
const SCRIPT_BY_PHASE: Record<VerifyPhase, string> = {
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

function outputChunk(value: ProjectCommandExecutionOutcome["stdout"]): VerifyOutputChunk {
  return {
    text: value.text,
    truncated: value.truncated,
    totalBytes: value.totalBytes,
    totalLines: value.totalLines,
  };
}

function emptyChunk(): VerifyOutputChunk {
  return { text: "", truncated: false, totalBytes: 0, totalLines: 0 };
}

function tail(value: string): string | undefined {
  const sanitized = value.replace(ANSI_SGR_PATTERN, "");
  if (sanitized.length === 0) return undefined;
  return sanitized.length <= MAX_FAILURE_TAIL ? sanitized : sanitized.slice(-MAX_FAILURE_TAIL);
}

function failureTail(step: VerifyStepResult): string | undefined {
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

function compactOutput(
  record: VerifyEvidenceRecord,
  currentRepositoryState?: VerifyRepositoryState,
): VerifyOutput {
  const perStep = record.perStep.map((step) => compactStep(step, true));
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
    ...(record.repositoryState === undefined ? {} : { repositoryState: record.repositoryState }),
    ...(record.provenance === undefined ? {} : { provenance: record.provenance }),
    ...(record.publication === undefined ? {} : { publication: record.publication }),
    ...(record.mutating === undefined ? {} : { mutating: record.mutating }),
    ...(record.concurrentExecutions === undefined
      ? {}
      : { concurrentExecutions: record.concurrentExecutions }),
    ...(record.stateDrift === undefined ? {} : { stateDrift: record.stateDrift }),
    ...(record.sharedExecution === undefined ? {} : { sharedExecution: record.sharedExecution }),
    ...stateOutput(record.repositoryState, currentRepositoryState),
  };
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

function repositoryStateMatches(
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
    repositoryStateStatus: repositoryStateMatches(recorded, current),
  };
}

function fullOutput(
  record: VerifyEvidenceRecord,
  currentRepositoryState?: VerifyRepositoryState,
): VerifyOutput {
  const perStep = record.perStep.map(fullStep);
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
    ...(record.repositoryState === undefined ? {} : { repositoryState: record.repositoryState }),
    ...(record.provenance === undefined ? {} : { provenance: record.provenance }),
    ...(record.publication === undefined ? {} : { publication: record.publication }),
    ...(record.mutating === undefined ? {} : { mutating: record.mutating }),
    ...(record.concurrentExecutions === undefined
      ? {}
      : { concurrentExecutions: record.concurrentExecutions }),
    ...(record.stateDrift === undefined ? {} : { stateDrift: record.stateDrift }),
    ...(record.sharedExecution === undefined ? {} : { sharedExecution: record.sharedExecution }),
    ...stateOutput(record.repositoryState, currentRepositoryState),
  };
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
): Promise<void> {
  let loaded;
  try {
    loaded = await policy.load(ctx.cwd);
  } catch {
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
    findDecision: (current, currentIdentity) => {
      const orchestration = readProjectCommandOrchestrationContext();
      const decision = findProjectCommandPolicyDecision(current, currentIdentity, false);
      // A persisted flow grant is meaningful only while the process is in the
      // effective flow scope. A bare environment variable never authorizes a
      // command; an absent/session scope deliberately prompts again.
      if (orchestration.effectiveScope !== "flow") {
        return decision === "deny-global" || decision === "deny-project" ? decision : "unknown";
      }
      return decision;
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
  });
}

function stepDefinition(phase: VerifyPhase, script: string): ProjectCommandDefinition {
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

interface PreparedStep {
  readonly phase: VerifyPhase;
  readonly resolved: ResolvedProjectCommand;
}

async function resolveSteps(
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

function completedOutput(
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
    ...(record.repositoryState === undefined ? {} : { repositoryState: record.repositoryState }),
    ...(record.provenance === undefined ? {} : { provenance: record.provenance }),
    ...(record.publication === undefined ? {} : { publication: record.publication }),
    ...(record.mutating === undefined ? {} : { mutating: record.mutating }),
    ...(record.concurrentExecutions === undefined
      ? {}
      : { concurrentExecutions: record.concurrentExecutions }),
    ...(record.stateDrift === undefined ? {} : { stateDrift: record.stateDrift }),
    ...(record.sharedExecution === undefined ? {} : { sharedExecution: record.sharedExecution }),
    ...stateOutput(record.repositoryState, currentRepositoryState),
  };
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
    readonly concurrentExecutions?: number;
    readonly stateDrift?: boolean;
    readonly sharedExecution?: boolean;
    readonly mutating?: boolean;
  },
): void {
  const orchestration = readProjectCommandOrchestrationContext();
  const output = record.perStep.reduce(
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
  recordProjectCommandInvocation(recorder, {
    sessionId: sessionId(ctx),
    toolCallId,
    schemaHash: hash(verifyInputSchema),
    commandId: "verify",
    redactedParameters: {
      phases: prepared.map(({ phase }) => phase),
      coercions: input.coercions,
    },
    resultCategory: record.verdict === "passed" ? "PASS" : "IMPLEMENTATION_FAILURE",
    status: record.verdict === "failed" ? "nonzero" : "success",
    executed: !reused,
    reason: input.fresh
      ? "executed-forced-cache-bypass"
      : reused
        ? "reused-cache-hit"
        : "executed-cache-ineligible",
    cacheDecision: input.fresh ? "forced" : reused ? "hit" : "ineligible",
    forced: input.fresh,
    reused,
    durationMs: durationMs(startedAt),
    executionDurationMs: reused ? 0 : durationMs(startedAt),
    output,
    measurements: createProjectCommandInvocationMeasurements(
      input.fresh ? "forced" : reused ? "hit" : "ineligible",
      reused,
      output,
    ),
    ...(orchestration.orchestrated ? { producerScope: orchestration.effectiveScope } : {}),
    ...(orchestration.flowId === undefined ? {} : { flowId: orchestration.flowId }),
    ...(orchestration.delegationId === undefined
      ? {}
      : { delegationId: orchestration.delegationId }),
    ...(orchestration.role === undefined ? {} : { role: orchestration.role }),
    ref: record.ref,
    ...(record.repositoryState === undefined
      ? {}
      : {
          repositoryState: {
            ...record.repositoryState,
            readable: true,
          },
        }),
    verdict: record.verdict,
    mutating:
      telemetry?.mutating ??
      prepared.some(({ phase, resolved }) =>
        projectCommandMutatesWorkspace(
          stepDefinition(phase, resolved.scriptKey ?? SCRIPT_BY_PHASE[phase]),
          resolved,
        ),
      ),
    ...(publication === undefined ? {} : { publication }),
    coercions: input.coercions,
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
  const stepController = new AbortController();
  const abortStep = () => stepController.abort();
  options.aggregateController.signal.addEventListener("abort", abortStep, { once: true });
  let stepTimedOut = false;
  const stepTimer = setTimeout(() => {
    stepTimedOut = true;
    stepController.abort();
  }, options.stepTimeoutMs);
  const startedAt = performance.now();
  let outcome: ProjectCommandExecutionOutcome;
  let sharedExecution = false;
  const mutating = projectCommandMutatesWorkspace(
    stepDefinition(phase, step.resolved.scriptKey ?? SCRIPT_BY_PHASE[phase]),
    step.resolved,
  );
  const singleFlightKey =
    options.input.fresh || mutating
      ? undefined
      : hash({
          projectPath: options.projectPath,
          repositoryState: options.repositoryState,
          phase,
          command: displayCommand(step.resolved),
          scriptFingerprint: scriptFingerprint(step.resolved),
        });
  const existing =
    singleFlightKey === undefined ? undefined : VERIFY_STEP_SINGLE_FLIGHTS.get(singleFlightKey);
  let flight: VerifyStepSingleFlight | undefined;
  if (existing !== undefined) {
    existing.active += 1;
    options.telemetry.concurrentExecutions = Math.max(
      options.telemetry.concurrentExecutions,
      existing.active,
    );
    sharedExecution = true;
  } else if (singleFlightKey !== undefined) {
    flight = {
      promise: Promise.resolve().then(() =>
        options.executor(step.resolved, options.projectPath, stepController.signal),
      ),
      active: 1,
    };
    VERIFY_STEP_SINGLE_FLIGHTS.set(singleFlightKey, flight);
    options.telemetry.concurrentExecutions = Math.max(options.telemetry.concurrentExecutions, 1);
  }
  try {
    outcome = await awaitVerifyStep(
      existing?.promise ??
        flight?.promise ??
        options.executor(step.resolved, options.projectPath, stepController.signal),
      options.requestSignal,
    );
    if (sharedExecution) {
      options.telemetry.sharedExecution = true;
    }
  } catch {
    if (options.requestSignal?.aborted && !options.isAggregateTimedOut()) {
      throw new VerifyToolError("cancelled", "verify was cancelled");
    }
    if (stepTimedOut || options.isAggregateTimedOut()) {
      outcome = timeoutOutcome();
    } else {
      throw new VerifyToolError("executor-failure", `verify ${phase} execution failed`);
    }
  } finally {
    clearTimeout(stepTimer);
    options.aggregateController.signal.removeEventListener("abort", abortStep);
    if (existing !== undefined) {
      existing.active -= 1;
    }
    if (singleFlightKey !== undefined && flight !== undefined) {
      if (VERIFY_STEP_SINGLE_FLIGHTS.get(singleFlightKey) === flight) {
        VERIFY_STEP_SINGLE_FLIGHTS.delete(singleFlightKey);
      }
    }
  }
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

function createVerifyToolWithDependencies(
  policy: PolicyStore,
  executor: ProjectCommandExecutor,
  resolver: ProjectCommandResolver,
  repositoryStateReader: ProjectCommandRepositoryStateReader | undefined,
  cache: VerifyEvidenceCache,
  aggregateTimeoutMs: number,
  stepTimeoutMs: number,
  invocationRecorder?: ProjectCommandInvocationRecorder,
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
      const invocationStartedAt = performance.now();
      const input = validateVerifyInput(rawParams);
      const requestSignal = signal ?? ctx.signal;
      if (requestSignal?.aborted) throw new VerifyToolError("cancelled", "verify was cancelled");
      if (input.ref !== undefined) {
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
        const record = cache.getByRef(input.ref, input.flowId);
        if (record === undefined) {
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
          throw new VerifyToolError(
            "not-found",
            `validation ref not found in ${bucket}. ${guidance}`,
          );
        }
        let currentRepositoryState: VerifyRepositoryState | undefined;
        if (repositoryStateReader !== undefined) {
          try {
            currentRepositoryState = await readVerifyRepositoryState(
              repositoryStateReader,
              record.projectPath,
              requestSignal,
            );
          } catch (error) {
            if (error instanceof VerifyToolError && error.code === "cancelled") throw error;
          }
        }
        recordVerifyInvocation(
          invocationRecorder,
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
            sharedExecution: record.sharedExecution,
            mutating: record.mutating,
          },
        );
        return result(fullOutput(record, currentRepositoryState));
      }
      if (requestSignal?.aborted) throw new VerifyToolError("cancelled", "verify was cancelled");
      let loadedPolicy;
      try {
        loadedPolicy = await policy.load(ctx.cwd);
      } catch {
        throw new VerifyToolError("policy-load-failure", "verify policy could not be loaded");
      }
      const prepared = await resolveSteps(input, loadedPolicy.projectPath, resolver, requestSignal);
      const stateBeforeAuthorization =
        repositoryStateReader === undefined
          ? undefined
          : await readVerifyRepositoryState(
              repositoryStateReader,
              loadedPolicy.projectPath,
              requestSignal,
            );
      const resolvedCommands = prepared.map(({ resolved }) => displayCommand(resolved));
      const authorizationCommands = prepared.map(
        ({ phase, resolved }) =>
          `${phase}: ${displayCommand(resolved)} [script-sha256:${scriptFingerprint(resolved)}]`,
      );
      const identity = verificationIdentity(prepared, input);
      await authorizeVerify(policy, ctx, requestSignal, identity, authorizationCommands);
      if (requestSignal?.aborted) throw new VerifyToolError("cancelled", "verify was cancelled");
      let state = stateBeforeAuthorization;
      let repositoryStateReliable = repositoryStateReader === undefined;
      if (repositoryStateReader !== undefined) {
        try {
          state = await readVerifyRepositoryState(
            repositoryStateReader,
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
      if (
        !input.fresh &&
        input.publish === undefined &&
        state !== undefined &&
        repositoryStateReader !== undefined
      ) {
        const cached = cache.get(key);
        if (cached !== undefined) {
          let stableState: VerifyRepositoryState | undefined;
          try {
            stableState = await readVerifyRepositoryState(
              repositoryStateReader,
              loadedPolicy.projectPath,
              requestSignal,
            );
          } catch (error) {
            if (error instanceof VerifyToolError && error.code === "cancelled") throw error;
          }
          const stableKey = cacheKey(loadedPolicy.projectPath, stableState, prepared, input);
          if (stableState !== undefined && stableKey === key) {
            recordVerifyInvocation(
              invocationRecorder,
              ctx,
              toolCallId,
              invocationStartedAt,
              input,
              prepared,
              cached,
              true,
            );
            return result(compactOutput(cached, stableState));
          }
          state = stableState;
          key = stableKey;
          repositoryStateReliable = stableState !== undefined;
        }
      }
      const ref = `vr_${key.slice(0, 24)}`;

      const aggregateController = new AbortController();
      const abortAggregate = () => aggregateController.abort();
      requestSignal?.addEventListener("abort", abortAggregate, { once: true });
      let aggregateTimedOut = false;
      const aggregateTimer = setTimeout(() => {
        aggregateTimedOut = true;
        aggregateController.abort();
      }, aggregateTimeoutMs);
      const byPhase = new Map<VerifyPhase, PreparedStep>(
        prepared.map((step) => [step.phase, step]),
      );
      const steps: VerifyStepResult[] = [];
      const verifyStepTelemetry = {
        sharedExecution: false,
        concurrentExecutions: 1,
      };
      try {
        await runVerifySteps({
          input,
          prepared: byPhase,
          projectPath: loadedPolicy.projectPath,
          repositoryState: state,
          executor,
          aggregateController,
          requestSignal,
          stepTimeoutMs,
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
      const verdict = aggregateVerdict(steps);
      const firstFailure = steps.find((step) => step.status === "failed");
      const orchestration = readProjectCommandOrchestrationContext();
      let finalState = state;
      let stableForCache = repositoryStateReliable;
      let stateDrift = false;
      if (repositoryStateReader !== undefined) {
        try {
          finalState = await readVerifyRepositoryState(
            repositoryStateReader,
            loadedPolicy.projectPath,
            requestSignal,
          );
          stableForCache =
            state !== undefined &&
            finalState !== undefined &&
            cacheKey(loadedPolicy.projectPath, finalState, prepared, input) === key;
          stateDrift =
            state !== undefined &&
            finalState !== undefined &&
            repositoryStateMatches(state, finalState) === "mismatch";
        } catch (error) {
          if (error instanceof VerifyToolError && error.code === "cancelled") throw error;
          finalState = undefined;
          stableForCache = false;
        }
      }
      const record: VerifyEvidenceRecord = {
        cacheFormatVersion: VERIFY_CACHE_FORMAT_VERSION,
        key,
        ref,
        projectPath: loadedPolicy.projectPath,
        ...(state === undefined ? {} : { repositoryState: state }),
        resolvedCommands,
        perStep: steps,
        verdict,
        ...(firstFailure?.failureTail === undefined
          ? {}
          : { failureTail: firstFailure.failureTail }),
        covers: input.covers,
        createdAt: Date.now(),
        provenance: {
          scope: orchestration.effectiveScope === "flow" ? "flow" : "root",
          ...(orchestration.flowId === undefined ? {} : { flowId: orchestration.flowId }),
          ...(state === undefined ? {} : { repositoryIdentity: state.repositoryIdentity }),
        },
        mutating: prepared.some(({ phase, resolved }) =>
          projectCommandMutatesWorkspace(
            stepDefinition(phase, resolved.scriptKey ?? SCRIPT_BY_PHASE[phase]),
            resolved,
          ),
        ),
        concurrentExecutions: Math.max(1, verifyStepTelemetry.concurrentExecutions),
        stateDrift,
        sharedExecution: verifyStepTelemetry.sharedExecution,
      };
      if (stableForCache && !verifyStepTelemetry.sharedExecution) cache.set(record);
      let outputRecord = record;
      let publication: ProjectCommandInvocationPublicationMetadata | undefined;
      if (input.publish !== undefined) {
        if (!stableForCache || state === undefined || finalState === undefined) {
          throw new VerifyToolError(
            "publication-failure",
            `verify could not publish ${record.ref}: repository state is unreadable or changed during execution; rerun with a readable, stable repository`,
          );
        }
        if (state.repositoryIdentity !== finalState.repositoryIdentity) {
          throw new VerifyToolError(
            "publication-failure",
            `verify could not publish ${record.ref}: repository identity changed from ${state.repositoryIdentity} to ${finalState.repositoryIdentity}`,
          );
        }
        const published = cache.publish?.(
          record.ref,
          input.publish.flowId,
          finalState.repositoryIdentity,
        );
        if (published === undefined) {
          throw new VerifyToolError(
            "publication-failure",
            `verify could not publish ${record.ref} to flow ${input.publish.flowId}: no compatible stable evidence was stored`,
          );
        }
        outputRecord = published;
        publication = {
          scope: "flow",
          flowId: input.publish.flowId,
          published: true,
        };
      }
      recordVerifyInvocation(
        invocationRecorder,
        ctx,
        toolCallId,
        invocationStartedAt,
        input,
        prepared,
        outputRecord,
        false,
        publication,
        {
          concurrentExecutions: record.concurrentExecutions,
          stateDrift: record.stateDrift,
          sharedExecution: record.sharedExecution,
          mutating: record.mutating,
        },
      );
      return result(
        completedOutput(
          outputRecord,
          false,
          stableForCache ? outputRecord.ref : undefined,
          finalState,
        ),
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
  );
}
