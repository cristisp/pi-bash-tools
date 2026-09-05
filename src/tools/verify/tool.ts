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
}

export type VerifyToolDefinition = Omit<
  ToolDefinition<typeof verifyInputSchema, VerifyOutput>,
  "execute"
> & { execute: VerifyToolExecute };

const DEFAULT_AGGREGATE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_STEP_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_FAILURE_TAIL = 8 * 1024;
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

function compactOutput(record: VerifyEvidenceRecord): VerifyOutput {
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

function fullOutput(record: VerifyEvidenceRecord): VerifyOutput {
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
    findDecision: (current, currentIdentity) =>
      findProjectCommandPolicyDecision(current, currentIdentity, false),
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
      commands: prepared.map(({ phase, resolved }) => ({
        phase,
        command: displayCommand(resolved),
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

interface VerifyStepRunOptions {
  readonly input: NormalizedVerifyInput;
  readonly prepared: ReadonlyMap<VerifyPhase, PreparedStep>;
  readonly projectPath: string;
  readonly executor: ProjectCommandExecutor;
  readonly aggregateController: AbortController;
  readonly requestSignal: AbortSignal | undefined;
  readonly stepTimeoutMs: number;
  readonly isAggregateTimedOut: () => boolean;
  readonly steps: VerifyStepResult[];
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
  try {
    outcome = await options.executor(step.resolved, options.projectPath, stepController.signal);
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
): VerifyToolDefinition {
  return {
    name: "verify",
    label: "Verify",
    description:
      "Run package-script format, lint, typecheck, and test phases in fixed order with bounded validation evidence and stable lookup references. Root-session refs are process-scoped; flow refs are durable only within an authorized flow.",
    promptSnippet: "Run fixed-order project verification",
    parameters: verifyInputSchema,
    executionMode: "sequential",
    renderCall(_args, theme) {
      return renderCallLine(theme, "verify", []);
    },
    async execute(
      _toolCallId,
      rawParams,
      signal,
      _onUpdate: AgentToolUpdateCallback<VerifyOutput> | undefined,
      ctx,
    ) {
      const input = validateVerifyInput(rawParams);
      const requestSignal = signal ?? ctx.signal;
      if (requestSignal?.aborted) throw new VerifyToolError("cancelled", "verify was cancelled");
      if (input.ref !== undefined) {
        const record = cache.getByRef(input.ref);
        if (record === undefined) {
          const orchestration = readProjectCommandOrchestrationContext();
          const bucket =
            orchestration.effectiveScope === "flow" && orchestration.flowId !== undefined
              ? "the authorized flow cache"
              : "the process-local root-session cache";
          const guidance =
            bucket === "the process-local root-session cache"
              ? "Root-session refs are process-scoped and are not durable across processes."
              : "Only refs from the current authorized flow are searchable.";
          throw new VerifyToolError(
            "not-found",
            `validation ref not found in ${bucket}. ${guidance}`,
          );
        }
        return result(fullOutput(record));
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
      if (state !== undefined && repositoryStateReader !== undefined) {
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
            return result(compactOutput(cached));
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
      try {
        await runVerifySteps({
          input,
          prepared: byPhase,
          projectPath: loadedPolicy.projectPath,
          executor,
          aggregateController,
          requestSignal,
          stepTimeoutMs,
          isAggregateTimedOut: () => aggregateTimedOut,
          steps,
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
      };
      let stableForCache = repositoryStateReliable;
      if (state !== undefined && repositoryStateReader !== undefined) {
        try {
          const finalState = await readVerifyRepositoryState(
            repositoryStateReader,
            loadedPolicy.projectPath,
            requestSignal,
          );
          stableForCache =
            finalState !== undefined &&
            cacheKey(loadedPolicy.projectPath, finalState, prepared, input) === key;
        } catch (error) {
          if (error instanceof VerifyToolError && error.code === "cancelled") throw error;
          stableForCache = false;
        }
      }
      if (stableForCache) cache.set(record);
      return result(completedOutput(record, false, stableForCache ? record.ref : undefined));
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
  );
}
