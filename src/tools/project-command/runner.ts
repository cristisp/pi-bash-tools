import { performance } from "node:perf_hooks";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createToolErrorContract,
  withToolErrorContract,
  type ResultCategory,
  type ToolErrorContract,
} from "../errors.ts";
import { authorizeOrPrompt, type AuthorizationErrorKind } from "../authorization.ts";
import { findProjectCommandPolicyDecision } from "../policy/decisions.ts";
import type { CommandIdentity, PolicyStore } from "../policy/types.ts";
import {
  getProjectCommandReusePolicy,
  projectCommandIdentity,
  type ProjectCommandDefinition,
} from "./definitions.ts";
import type { ProjectCommandExecutionOutcome } from "./execution.ts";
import { definedObjectProperties } from "./defined-properties.ts";
import {
  createProjectCommandResultCache,
  type ProjectCommandCacheDecision,
  type ProjectCommandResultCache,
  type ProjectCommandResultCacheEntry,
} from "./cache.ts";
import {
  createProjectCommandLogicalRequestKey,
  createProjectCommandResultFingerprint,
  projectCommandPolicyId,
  PROJECT_COMMAND_RESULT_FINGERPRINT_VERSION,
} from "./fingerprint.ts";
import { createNodeProjectRelevantInputDiscovery } from "./node/relevant-inputs.ts";
import {
  canonicalProjectCommandRelevantInputs,
  type ProjectCommandRelevantInputDiscovery,
  type ProjectCommandRelevantInputDiscoveryRequest,
  type ProjectCommandRelevantInputs,
} from "./relevant-inputs.ts";
import {
  equalProjectCommandStateSnapshots,
  projectCommandStateSnapshotDigest,
  snapshotProjectCommandRelevantInputs,
  type ProjectCommandStateSnapshot,
  type ProjectCommandStateSnapshotter,
} from "./state-snapshot.ts";
import {
  createExecutionFailure,
  createResolutionFailure,
  displayCommand,
  outputDetails,
  suggestedActionForCategory,
  type ProjectCommandInvocationMetadata,
  type ProjectCommandOutputDetails,
  type ProjectCommandRequestParameters,
} from "./output.ts";
import { projectCommandResultCategory } from "./categories.ts";
import {
  recordProjectCommandInvocation,
  redactProjectCommandParameters,
  type ProjectCommandInvocationOutputMetadata,
  type ProjectCommandInvocationReason,
  type ProjectCommandInvocationRecorder,
} from "../../observability/project-command-invocation.ts";
import { ProjectCommandResolutionError, isProjectCommandResolutionError } from "./resolution.ts";
import type { ProjectCommandResolver, ResolvedProjectCommand } from "./resolution/types.ts";
import {
  cancellationError,
  invalidRequest,
  ProjectCommandToolError,
  type ProjectCommandInputFor,
  validateProjectCommandInput,
} from "./schema.ts";

export type ProjectCommandToolContext = Omit<
  Pick<ExtensionContext, "cwd" | "signal" | "hasUI" | "mode" | "ui">,
  "ui"
> & {
  readonly ui: Pick<ExtensionContext["ui"], "select">;
  readonly sessionManager?: Pick<ExtensionContext["sessionManager"], "getSessionId">;
};

export type ProjectCommandExecutor = (
  resolved: ResolvedProjectCommand,
  cwd: string,
  signal: AbortSignal | undefined,
) => Promise<ProjectCommandExecutionOutcome>;

export interface ProjectCommandInvocationOptions {
  readonly recorder?: ProjectCommandInvocationRecorder;
  readonly schemaHash?: string;
}

export type ProjectCommandExecute<Definitions extends readonly ProjectCommandDefinition[]> = (
  toolCallId: string,
  params: ProjectCommandInputFor<Definitions>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<ProjectCommandOutputDetails> | undefined,
  ctx: ProjectCommandToolContext,
) => Promise<AgentToolResult<ProjectCommandOutputDetails>>;

function result(
  details: ProjectCommandOutputDetails,
): AgentToolResult<ProjectCommandOutputDetails> {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  };
}

function elapsedMilliseconds(start: number, end: number): number {
  const elapsed = end - start;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
}

interface InvocationMetadataOptions {
  readonly cacheDecision?: ProjectCommandCacheDecision;
  readonly forced?: boolean;
  readonly reused?: boolean;
  readonly authFingerprint?: string;
  readonly policyId?: string;
  readonly reusePolicyId?: string;
  readonly resultFingerprint?: string;
  readonly relevantInputs?: ProjectCommandRelevantInputs;
  readonly producerInvocationId?: string;
}

function invocationMetadata(
  toolCallId: string,
  startedAt: number,
  executionStartedAt: number | undefined,
  finishedAt: number,
  options: InvocationMetadataOptions = {},
): ProjectCommandInvocationMetadata {
  const executionDurationMs =
    executionStartedAt === undefined ? 0 : elapsedMilliseconds(executionStartedAt, finishedAt);
  const durationMs = Math.max(elapsedMilliseconds(startedAt, finishedAt), executionDurationMs);
  return {
    toolCallId,
    durationMs,
    executionDurationMs,
    reused: options.reused ?? false,
    cacheDecision: options.cacheDecision ?? "ineligible",
    forced: options.forced ?? false,
    ...definedObjectProperties([
      ["authFingerprint", options.authFingerprint],
      ["policyId", options.policyId],
      ["reusePolicyId", options.reusePolicyId],
      ["relevantInputs", options.relevantInputs],
      [
        "resultFingerprintVersion",
        options.resultFingerprint === undefined
          ? undefined
          : PROJECT_COMMAND_RESULT_FINGERPRINT_VERSION,
      ],
      ["resultFingerprint", options.resultFingerprint],
      ["producerInvocationId", options.producerInvocationId],
    ]),
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function enrichToolError(
  error: ProjectCommandToolError,
  metadata: ProjectCommandInvocationMetadata,
): ProjectCommandToolError {
  const details = isRecord(error.details)
    ? { ...error.details, ...metadata }
    : { ...metadata, detail: error.details };
  const enriched = new ProjectCommandToolError(error.message, details, error.contract);
  enriched.name = error.name;
  return enriched;
}

async function resolveCommandForTool(
  resolver: ProjectCommandResolver,
  definition: ProjectCommandDefinition,
  projectPath: string,
  signal: AbortSignal | undefined,
  params: ProjectCommandRequestParameters,
): Promise<ResolvedProjectCommand> {
  try {
    return await resolver(definition, projectPath, signal, params);
  } catch (error) {
    if (error instanceof ProjectCommandToolError && error.name === "AbortError") {
      throw error;
    }
    if (signal?.aborted) {
      throw commandCancellationError();
    }
    if (isProjectCommandResolutionError(error)) {
      throw createResolutionFailure(params, error);
    }
    throw createResolutionFailure(
      params,
      new ProjectCommandResolutionError("probe", "resolution-failure"),
    );
  }
}

function commandCancellationError(): ProjectCommandToolError {
  return cancellationError();
}

const PROJECT_COMMAND_AUTHORIZATION_MESSAGES: Record<
  Exclude<AuthorizationErrorKind, "cancelled" | "dismissed">,
  string
> = {
  denied: "Project command denied by policy",
  "denied-once": "Project command denied for this request",
  "not-authorized": "Project command is not authorized in this mode",
  timeout: "Project command confirmation timed out",
  confirmation: "Project command confirmation failed",
  save: "Unable to save project command policy",
  "unsafe-global": "Project command cannot be allowed globally",
  "invalid-choice": "Project command confirmation returned an invalid choice",
  load: "Unable to load project command policy",
};

function authorizationContract(
  kind: Exclude<AuthorizationErrorKind, "cancelled" | "dismissed">,
): ToolErrorContract {
  const blocked =
    kind === "denied" ||
    kind === "denied-once" ||
    kind === "not-authorized" ||
    kind === "unsafe-global";
  const timeout = kind === "timeout";
  return createToolErrorContract({
    code: timeout ? "confirmation-timeout" : `policy-${kind}`,
    category: blocked ? "BLOCKED" : timeout ? "TIMEOUT" : "POLICY_FAILURE",
    explanation: PROJECT_COMMAND_AUTHORIZATION_MESSAGES[kind],
    suggestedAction: suggestedActionForCategory(
      blocked ? "BLOCKED" : timeout ? "TIMEOUT" : "POLICY_FAILURE",
    ),
    retryable: timeout || !blocked,
    executed: false,
  });
}

function authorizationError(kind: AuthorizationErrorKind): ProjectCommandToolError {
  if (kind === "cancelled" || kind === "dismissed") {
    return commandCancellationError();
  }
  const message = PROJECT_COMMAND_AUTHORIZATION_MESSAGES[kind];
  const contract = authorizationContract(kind);
  return new ProjectCommandToolError(message, withToolErrorContract({}, contract), contract);
}

function throwIfRequestAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw commandCancellationError();
  }
}

async function loadPolicy(policy: PolicyStore, cwd: string, signal: AbortSignal | undefined) {
  throwIfRequestAborted(signal);
  try {
    const loaded = await policy.load(cwd);
    throwIfRequestAborted(signal);
    return loaded;
  } catch (error) {
    if (error instanceof ProjectCommandToolError && error.name === "AbortError") {
      throw error;
    }
    if (signal?.aborted) {
      throw commandCancellationError();
    }
    const contract = createToolErrorContract({
      code: "policy-load-failure",
      category: "POLICY_FAILURE",
      explanation: "The project command policy could not be loaded.",
      suggestedAction: suggestedActionForCategory("POLICY_FAILURE"),
      retryable: true,
      executed: false,
    });
    throw new ProjectCommandToolError(
      "Unable to load project command policy",
      withToolErrorContract({}, contract),
      contract,
    );
  }
}

async function authorizeCommand(
  policy: PolicyStore,
  loaded: Awaited<ReturnType<PolicyStore["load"]>>,
  definition: ProjectCommandDefinition,
  identity: CommandIdentity,
  resolved: ResolvedProjectCommand,
  ctx: ProjectCommandToolContext,
  signal: AbortSignal | undefined,
): Promise<void> {
  await authorizeOrPrompt<
    CommandIdentity,
    Extract<import("../policy/types.ts").PolicyDecisionRequest, { kind: "project-command" }>
  >({
    identity,
    loaded,
    context: ctx,
    signal,
    globalSafe: definition.globalSafe,
    allowGlobal: false,
    deferAllowPersistence: false,
    findDecision: (current, currentIdentity) =>
      findProjectCommandPolicyDecision(current, currentIdentity, definition.globalSafe),
    recordDecisions: (projectPath, requests, requestSignal) =>
      policy.recordDecisions(projectPath, requests, requestSignal),
    makeRequest: (currentIdentity, decision) => ({
      kind: "project-command",
      identity: currentIdentity,
      decision,
      globalSafe: definition.globalSafe,
    }),
    promptText: (currentIdentity) =>
      `Authorize project command ${currentIdentity.commandId}: ${displayCommand(resolved)}${
        resolved.script === undefined ? "" : `\nScript: ${resolved.script}`
      }`,
    error: authorizationError,
  });
}

function cancellationOutcome(): ProjectCommandExecutionOutcome {
  return {
    status: "cancelled",
    exit: { code: null, signal: null },
    timedOut: false,
    cancelled: true,
    executed: true,
    stdout: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
    stderr: { text: "", truncated: false, totalBytes: 0, totalLines: 0 },
  };
}

function cancellationOutputDetails(
  details: ProjectCommandOutputDetails,
): ProjectCommandOutputDetails {
  return {
    ...details,
    status: "cancelled",
    category: "CANCELLED",
    executed: true,
    exit: { code: null, signal: null },
    timedOut: false,
    cancelled: true,
    suggestedAction: suggestedActionForCategory("CANCELLED"),
  };
}

function executorFailure(): ProjectCommandToolError {
  const contract = createToolErrorContract({
    code: "executor-failure",
    category: "IMPLEMENTATION_FAILURE",
    explanation: "The project command executor failed.",
    suggestedAction: suggestedActionForCategory("IMPLEMENTATION_FAILURE"),
    retryable: false,
    executed: true,
  });
  return new ProjectCommandToolError(
    "Project command executor failed",
    withToolErrorContract({}, contract),
    contract,
  );
}

async function executeAuthorizedCommand(
  executor: ProjectCommandExecutor,
  resolved: ResolvedProjectCommand,
  projectPath: string,
  signal: AbortSignal | undefined,
): Promise<ProjectCommandExecutionOutcome> {
  try {
    return await executor(resolved, projectPath, signal);
  } catch {
    if (signal?.aborted) {
      return cancellationOutcome();
    }
    throw executorFailure();
  }
}

function hasAcceptedExitCode(
  resolved: ResolvedProjectCommand,
  outcome: ProjectCommandExecutionOutcome,
): boolean {
  return (
    outcome.status === "nonzero" &&
    outcome.exit.code !== null &&
    (resolved.definition.acceptedExitCodes?.includes(outcome.exit.code) ?? false)
  );
}

function isCacheableOutcome(
  resolved: ResolvedProjectCommand,
  outcome: ProjectCommandExecutionOutcome,
): boolean {
  if (outcome.executed === false || outcome.cancelled || outcome.timedOut) return false;
  if (outcome.status === "success") return true;
  return hasAcceptedExitCode(resolved, outcome);
}

function isAbortedOutcome(
  outcome: ProjectCommandExecutionOutcome,
  signal: AbortSignal | undefined,
): boolean {
  return outcome.status === "cancelled" || signal?.aborted === true;
}

function isFailedOutcome(
  resolved: ResolvedProjectCommand,
  outcome: ProjectCommandExecutionOutcome,
): boolean {
  return outcome.status !== "success" && !hasAcceptedExitCode(resolved, outcome);
}

function stripForce(
  params: Readonly<Record<string, unknown>> & { readonly commandId: string },
): ProjectCommandRequestParameters {
  const { force: _force, ...withoutForce } = params;
  return withoutForce;
}

function getContextSessionId(ctx: ProjectCommandToolContext): string | undefined {
  const value = ctx.sessionManager?.getSessionId();
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function createDefaultRelevantInputDiscovery(): ProjectCommandRelevantInputDiscovery {
  const nodeDiscovery = createNodeProjectRelevantInputDiscovery();
  return Object.freeze({
    discover: async (
      request: ProjectCommandRelevantInputDiscoveryRequest,
      signal: AbortSignal | undefined,
    ) => {
      const discovered = await nodeDiscovery.discover(request, signal);
      if (
        discovered.status === "incomplete" &&
        discovered.reason === "unsupported-project-command" &&
        getProjectCommandReusePolicy(request.definition) === "static"
      ) {
        return Object.freeze({
          status: "complete" as const,
          inputs: canonicalProjectCommandRelevantInputs(),
        });
      }
      return discovered;
    },
  });
}

async function discoverRelevantInputs(
  discovery: ProjectCommandRelevantInputDiscovery,
  definition: ProjectCommandDefinition,
  projectPath: string,
  parameters: ProjectCommandRequestParameters,
  signal: AbortSignal | undefined,
): Promise<ProjectCommandRelevantInputs | undefined> {
  try {
    const request =
      getProjectCommandReusePolicy(definition) === "workspace-snapshot"
        ? { kind: "workspace-snapshot" as const, definition, projectPath, parameters }
        : { definition, projectPath, parameters };
    const discovered = await discovery.discover(request, signal);
    return discovered.status === "complete" ? discovered.inputs : undefined;
  } catch {
    return undefined;
  }
}

async function takeStateSnapshot(
  snapshotter: ProjectCommandStateSnapshotter,
  projectPath: string,
  inputs: ProjectCommandRelevantInputs,
): Promise<ProjectCommandStateSnapshot | undefined> {
  try {
    const snapshot = await snapshotter(projectPath, inputs);
    return snapshot.status === "complete" ? snapshot.snapshot : undefined;
  } catch {
    return undefined;
  }
}

interface CacheInspection {
  readonly sessionId: string | undefined;
  readonly logicalRequestKey: string | undefined;
  readonly eligible: boolean;
  readonly decision: ProjectCommandCacheDecision;
  readonly entry?: ProjectCommandResultCacheEntry;
  readonly beforeSnapshot?: ProjectCommandStateSnapshot;
}

function cacheIsEligible(
  definition: ProjectCommandDefinition,
  relevantInputs: ProjectCommandRelevantInputs | undefined,
  resultFingerprint: string | undefined,
  logicalRequestKey: string | undefined,
  beforeSnapshot: ProjectCommandStateSnapshot | undefined,
  requestSessionId: string | undefined,
): boolean {
  return (
    resultFingerprint !== undefined &&
    logicalRequestKey !== undefined &&
    relevantInputs !== undefined &&
    beforeSnapshot !== undefined &&
    requestSessionId !== undefined &&
    getProjectCommandReusePolicy(definition) !== "never"
  );
}

function lookupCacheEntry(
  cache: ProjectCommandResultCache,
  sessionId: string,
  logicalRequestKey: string,
  forced: boolean,
): {
  readonly decision: ProjectCommandCacheDecision;
  readonly entry?: ProjectCommandResultCacheEntry;
} {
  const entry = cache.get(sessionId, logicalRequestKey);
  if (forced) return entry === undefined ? { decision: "forced" } : { decision: "forced", entry };
  return entry === undefined ? { decision: "miss" } : { decision: "hit", entry };
}

function invalidateStaleEntry(
  cache: ProjectCommandResultCache,
  sessionId: string,
  logicalRequestKey: string,
  resultFingerprint: string,
  beforeSnapshot: ProjectCommandStateSnapshot,
  lookup: {
    readonly decision: ProjectCommandCacheDecision;
    readonly entry?: ProjectCommandResultCacheEntry;
  },
): {
  readonly decision: ProjectCommandCacheDecision;
  readonly entry?: ProjectCommandResultCacheEntry;
} {
  const entry = lookup.entry;
  if (
    entry === undefined ||
    (entry.resultFingerprint === resultFingerprint &&
      equalProjectCommandStateSnapshots(beforeSnapshot, entry.snapshot))
  ) {
    return lookup;
  }
  cache.delete(sessionId, logicalRequestKey);
  return { decision: "invalidated" };
}

function inspectCacheEntry(
  cache: ProjectCommandResultCache,
  sessionId: string,
  logicalRequestKey: string,
  resultFingerprint: string,
  beforeSnapshot: ProjectCommandStateSnapshot,
  forced: boolean,
): {
  readonly decision: ProjectCommandCacheDecision;
  readonly entry?: ProjectCommandResultCacheEntry;
} {
  const inspected = invalidateStaleEntry(
    cache,
    sessionId,
    logicalRequestKey,
    resultFingerprint,
    beforeSnapshot,
    lookupCacheEntry(cache, sessionId, logicalRequestKey, forced),
  );
  if (!forced || inspected.decision === "invalidated") return inspected;
  return { decision: "forced" };
}

function inspectResultCache(
  definition: ProjectCommandDefinition,
  relevantInputs: ProjectCommandRelevantInputs | undefined,
  resultFingerprint: string | undefined,
  logicalRequestKey: string | undefined,
  forced: boolean,
  cache: ProjectCommandResultCache,
  signal: AbortSignal | undefined,
  requestSessionId: string | undefined,
  beforeSnapshot: ProjectCommandStateSnapshot | undefined,
): CacheInspection {
  const eligible = cacheIsEligible(
    definition,
    relevantInputs,
    resultFingerprint,
    logicalRequestKey,
    beforeSnapshot,
    requestSessionId,
  );
  if (!eligible || resultFingerprint === undefined || logicalRequestKey === undefined) {
    return {
      sessionId: requestSessionId,
      logicalRequestKey,
      eligible: false,
      decision: forced ? "forced" : "ineligible",
    };
  }
  if (beforeSnapshot === undefined || requestSessionId === undefined) {
    return {
      sessionId: requestSessionId,
      logicalRequestKey,
      eligible: false,
      decision: "ineligible",
    };
  }
  const inspected = inspectCacheEntry(
    cache,
    requestSessionId,
    logicalRequestKey,
    resultFingerprint,
    beforeSnapshot,
    forced,
  );
  throwIfRequestAborted(signal);
  return {
    sessionId: requestSessionId,
    logicalRequestKey,
    eligible,
    decision: inspected.decision,
    ...(inspected.entry === undefined ? {} : { entry: inspected.entry }),
    beforeSnapshot,
  };
}

interface AfterExecutionSnapshot {
  readonly decision: ProjectCommandCacheDecision;
  readonly snapshot?: ProjectCommandStateSnapshot;
}

async function snapshotAfterExecution(
  projectPath: string,
  aborted: boolean,
  cache: ProjectCommandResultCache,
  inspection: CacheInspection,
  relevantInputs: ProjectCommandRelevantInputs | undefined,
  stateSnapshotter: ProjectCommandStateSnapshotter,
): Promise<AfterExecutionSnapshot> {
  if (aborted || inspection.beforeSnapshot === undefined || relevantInputs === undefined) {
    return { decision: aborted ? "ineligible" : inspection.decision };
  }
  const snapshot = await takeStateSnapshot(stateSnapshotter, projectPath, relevantInputs);
  if (snapshot === undefined) return { decision: "ineligible" };
  if (equalProjectCommandStateSnapshots(inspection.beforeSnapshot, snapshot)) {
    return { decision: inspection.decision, snapshot };
  }
  if (inspection.sessionId !== undefined && inspection.logicalRequestKey !== undefined) {
    cache.delete(inspection.sessionId, inspection.logicalRequestKey);
  }
  return { decision: "invalidated", snapshot };
}

function executionCanBeStored(
  resolved: ResolvedProjectCommand,
  outcome: ProjectCommandExecutionOutcome,
): boolean {
  return outcome.executed !== false && !outcome.timedOut && isCacheableOutcome(resolved, outcome);
}

function snapshotsAreStable(
  inspection: CacheInspection,
  afterExecution: AfterExecutionSnapshot,
): boolean {
  return (
    inspection.beforeSnapshot !== undefined &&
    afterExecution.snapshot !== undefined &&
    equalProjectCommandStateSnapshots(inspection.beforeSnapshot, afterExecution.snapshot)
  );
}

function decisionAllowsStore(decision: ProjectCommandCacheDecision): boolean {
  return decision === "miss" || decision === "forced" || decision === "invalidated";
}

function canStoreResult(
  resolved: ResolvedProjectCommand,
  outcome: ProjectCommandExecutionOutcome,
  inspection: CacheInspection,
  afterExecution: AfterExecutionSnapshot,
  resultFingerprint: string | undefined,
): boolean {
  return (
    executionCanBeStored(resolved, outcome) &&
    inspection.eligible &&
    snapshotsAreStable(inspection, afterExecution) &&
    decisionAllowsStore(afterExecution.decision) &&
    inspection.sessionId !== undefined &&
    inspection.logicalRequestKey !== undefined &&
    resultFingerprint !== undefined
  );
}

interface ExecutedWithCache {
  readonly outcome: ProjectCommandExecutionOutcome;
  readonly afterSnapshot?: ProjectCommandStateSnapshot;
  readonly decision: ProjectCommandCacheDecision;
  readonly canStore: boolean;
}

function storeResult(
  cache: ProjectCommandResultCache,
  inspection: CacheInspection,
  resultFingerprint: string | undefined,
  executed: ExecutedWithCache,
  details: ProjectCommandOutputDetails,
  producerInvocationId: string,
): void {
  if (
    !executed.canStore ||
    inspection.sessionId === undefined ||
    inspection.logicalRequestKey === undefined ||
    resultFingerprint === undefined ||
    executed.afterSnapshot === undefined
  ) {
    return;
  }
  cache.set(inspection.sessionId, {
    logicalRequestKey: inspection.logicalRequestKey,
    resultFingerprint,
    details,
    snapshot: executed.afterSnapshot,
    producerInvocationId,
  });
}

async function executeWithCache(
  executor: ProjectCommandExecutor,
  resolved: ResolvedProjectCommand,
  projectPath: string,
  signal: AbortSignal | undefined,
  cache: ProjectCommandResultCache,
  inspection: CacheInspection,
  relevantInputs: ProjectCommandRelevantInputs | undefined,
  resultFingerprint: string | undefined,
  stateSnapshotter: ProjectCommandStateSnapshotter,
): Promise<ExecutedWithCache> {
  const outcome = await executeAuthorizedCommand(executor, resolved, projectPath, signal);
  const aborted = isAbortedOutcome(outcome, signal);
  const afterExecution = await snapshotAfterExecution(
    projectPath,
    aborted,
    cache,
    inspection,
    relevantInputs,
    stateSnapshotter,
  );
  const decision =
    !aborted && !isCacheableOutcome(resolved, outcome) && afterExecution.decision !== "invalidated"
      ? "ineligible"
      : afterExecution.decision;
  return {
    outcome,
    afterSnapshot: afterExecution.snapshot,
    decision,
    canStore: canStoreResult(
      resolved,
      outcome,
      inspection,
      { ...afterExecution, decision },
      resultFingerprint,
    ),
  };
}

interface ProjectCommandInvocationState {
  readonly startedAt: number;
  executionStartedAt: number | undefined;
  forced: boolean;
  reused: boolean;
  cacheDecision: ProjectCommandCacheDecision;
  authFingerprint: string | undefined;
  policyId: string | undefined;
  reusePolicyId: string | undefined;
  logicalRequestKey: string | undefined;
  resultFingerprint: string | undefined;
  relevantInputManifest: ProjectCommandRelevantInputs | undefined;
  beforeSnapshot: ProjectCommandStateSnapshot | undefined;
  producerInvocationId: string | undefined;
  commandId: string | undefined;
  redactedParameters: Readonly<Record<string, unknown>> | undefined;
  resultCategory: ResultCategory | undefined;
  status: ProjectCommandExecutionOutcome["status"] | undefined;
  executed: boolean;
  output: ProjectCommandInvocationOutputMetadata | undefined;
}

function createInvocationState(startedAt: number): ProjectCommandInvocationState {
  return {
    startedAt,
    executionStartedAt: undefined,
    forced: false,
    reused: false,
    cacheDecision: "ineligible",
    authFingerprint: undefined,
    policyId: undefined,
    reusePolicyId: undefined,
    logicalRequestKey: undefined,
    resultFingerprint: undefined,
    relevantInputManifest: undefined,
    beforeSnapshot: undefined,
    producerInvocationId: undefined,
    commandId: undefined,
    redactedParameters: undefined,
    resultCategory: undefined,
    status: undefined,
    executed: false,
    output: undefined,
  };
}

function setOutcomeInvocationState(
  state: ProjectCommandInvocationState,
  definition: ProjectCommandDefinition,
  outcome: ProjectCommandExecutionOutcome,
): void {
  state.resultCategory = projectCommandResultCategory(definition, outcome);
  state.status = outcome.status;
  state.executed = outcome.executed ?? true;
  state.output = {
    stdout: {
      truncated: outcome.stdout.truncated,
      totalBytes: outcome.stdout.totalBytes,
      totalLines: outcome.stdout.totalLines,
    },
    stderr: {
      truncated: outcome.stderr.truncated,
      totalBytes: outcome.stderr.totalBytes,
      totalLines: outcome.stderr.totalLines,
    },
  };
}

function setCachedInvocationState(
  state: ProjectCommandInvocationState,
  details: ProjectCommandOutputDetails,
): void {
  state.reused = true;
  state.resultCategory = details.category;
  state.status = details.status;
  state.executed = details.executed;
  state.output = details.output;
}

const EARLY_FAILURE_REASONS: Partial<Record<ResultCategory, ProjectCommandInvocationReason>> = {
  INVALID_REQUEST: "invalid-request",
  RESOLUTION_FAILURE: "resolution-failure",
  POLICY_FAILURE: "policy-failure",
  BLOCKED: "policy-failure",
  CANCELLED: "cancelled",
};

const CACHE_DECISION_REASONS: Record<ProjectCommandCacheDecision, ProjectCommandInvocationReason> =
  {
    miss: "executed-after-cache-miss",
    hit: "reused-cache-hit",
    forced: "executed-forced-cache-bypass",
    ineligible: "executed-cache-ineligible",
    invalidated: "executed-after-cache-invalidation",
  };

function invocationReason(state: ProjectCommandInvocationState): ProjectCommandInvocationReason {
  const earlyFailureReason =
    state.resultCategory === undefined ? undefined : EARLY_FAILURE_REASONS[state.resultCategory];
  if (earlyFailureReason !== undefined) return earlyFailureReason;
  if (state.reused) return "reused-cache-hit";
  if (state.forced) return "executed-forced-cache-bypass";
  if (state.status === undefined) {
    return state.executed ? "execution-failure" : "preparation-failure";
  }
  return CACHE_DECISION_REASONS[state.cacheDecision];
}

function recordInvocation(
  recorder: ProjectCommandInvocationRecorder | undefined,
  schemaHash: string | undefined,
  toolCallId: string,
  ctx: ProjectCommandToolContext,
  state: ProjectCommandInvocationState,
): void {
  try {
    const sessionId = getContextSessionId(ctx);
    if (sessionId === undefined) return;
    const finishedAt = performance.now();
    recordProjectCommandInvocation(recorder, {
      sessionId,
      toolCallId,
      schemaHash: schemaHash ?? "unknown",
      commandId: state.commandId,
      redactedParameters: state.redactedParameters,
      resultCategory: state.resultCategory ?? "IMPLEMENTATION_FAILURE",
      status: state.status,
      executed: state.executed,
      reason: invocationReason(state),
      cacheDecision: state.cacheDecision,
      forced: state.forced,
      reused: state.reused,
      durationMs: elapsedMilliseconds(state.startedAt, finishedAt),
      executionDurationMs:
        state.executionStartedAt === undefined
          ? 0
          : elapsedMilliseconds(state.executionStartedAt, finishedAt),
      output: state.output,
    });
  } catch {
    // Session lookup and record construction are also observational best effort.
  }
}

function invocationMetadataForState(
  toolCallId: string,
  state: ProjectCommandInvocationState,
  options: InvocationMetadataOptions = {},
): ProjectCommandInvocationMetadata {
  return invocationMetadata(
    toolCallId,
    state.startedAt,
    state.executionStartedAt,
    performance.now(),
    {
      cacheDecision: state.cacheDecision,
      forced: state.forced,
      authFingerprint: state.authFingerprint,
      policyId: state.policyId,
      reusePolicyId: state.reusePolicyId,
      resultFingerprint: state.resultFingerprint,
      relevantInputs: state.relevantInputManifest,
      producerInvocationId: state.producerInvocationId,
      ...options,
    },
  );
}

interface PreparedProjectCommand {
  readonly definition: ProjectCommandDefinition;
  readonly resolved: ResolvedProjectCommand;
  readonly identity: CommandIdentity;
  readonly projectPath: string;
  readonly relevantInputs: ProjectCommandRelevantInputs | undefined;
  readonly requestSignal: AbortSignal | undefined;
}

function setResultFingerprints(
  state: ProjectCommandInvocationState,
  definition: ProjectCommandDefinition,
  projectPath: string,
  resolved: ResolvedProjectCommand,
  relevantInputs: ProjectCommandRelevantInputs | undefined,
): void {
  if (
    relevantInputs === undefined ||
    state.authFingerprint === undefined ||
    state.policyId === undefined ||
    state.reusePolicyId === undefined
  ) {
    return;
  }
  const fingerprintInput = {
    authFingerprint: state.authFingerprint,
    projectPath,
    effectiveParameters: resolved.effectiveParameters ?? Object.freeze({}),
    processTimeoutMs: definition.processTimeoutMs,
    outputLimitBytes: definition.outputLimitBytes,
    policyId: state.policyId,
    reusePolicyId: state.reusePolicyId,
  };
  try {
    state.logicalRequestKey = createProjectCommandLogicalRequestKey(fingerprintInput);
    if (state.beforeSnapshot === undefined) return;
    const fingerprint = createProjectCommandResultFingerprint({
      ...fingerprintInput,
      stateDigest: projectCommandStateSnapshotDigest(state.beforeSnapshot),
      relevantInputs,
    });
    state.resultFingerprint = fingerprint.fingerprint;
    state.relevantInputManifest = fingerprint.relevantInputs;
  } catch {
    state.logicalRequestKey = undefined;
    state.resultFingerprint = undefined;
  }
}

async function prepareProjectCommand(
  policy: PolicyStore,
  resolver: ProjectCommandResolver,
  executorContext: ProjectCommandToolContext,
  rawParams: unknown,
  signal: AbortSignal | undefined,
  capturedDefinitions: readonly ProjectCommandDefinition[],
  byId: ReadonlyMap<string, ProjectCommandDefinition>,
  relevantInputDiscovery: ProjectCommandRelevantInputDiscovery,
  stateSnapshotter: ProjectCommandStateSnapshotter,
  state: ProjectCommandInvocationState,
): Promise<PreparedProjectCommand> {
  const validatedParams = validateProjectCommandInput(
    rawParams,
    capturedDefinitions,
  ) as ProjectCommandRequestParameters & { readonly force?: boolean };
  state.forced = validatedParams.force === true;
  const params = stripForce(validatedParams);
  state.commandId = params.commandId;
  state.redactedParameters = redactProjectCommandParameters(params);
  const definition = byId.get(params.commandId);
  if (definition === undefined) throw invalidRequest("commandId");
  const requestSignal = signal ?? executorContext.signal;
  const loaded = await loadPolicy(policy, executorContext.cwd, requestSignal);
  state.reusePolicyId = getProjectCommandReusePolicy(definition);
  const resolved = await resolveCommandForTool(
    resolver,
    definition,
    loaded.projectPath,
    requestSignal,
    params,
  );
  throwIfRequestAborted(requestSignal);
  const relevantInputs = await discoverRelevantInputs(
    relevantInputDiscovery,
    definition,
    loaded.projectPath,
    params,
    requestSignal,
  );
  throwIfRequestAborted(requestSignal);
  const identity = projectCommandIdentity(definition, resolved);
  state.authFingerprint = identity.fingerprint;
  await authorizeCommand(
    policy,
    loaded,
    definition,
    identity,
    resolved,
    executorContext,
    requestSignal,
  );
  throwIfRequestAborted(requestSignal);
  const authorizedPolicy = await loadPolicy(policy, executorContext.cwd, requestSignal);
  state.policyId = projectCommandPolicyId(authorizedPolicy);
  state.beforeSnapshot =
    relevantInputs === undefined
      ? undefined
      : await takeStateSnapshot(stateSnapshotter, loaded.projectPath, relevantInputs);
  setResultFingerprints(state, definition, loaded.projectPath, resolved, relevantInputs);
  return {
    definition,
    resolved,
    identity,
    projectPath: loaded.projectPath,
    relevantInputs,
    requestSignal,
  };
}

async function executePreparedProjectCommand(
  executor: ProjectCommandExecutor,
  cache: ProjectCommandResultCache,
  stateSnapshotter: ProjectCommandStateSnapshotter,
  prepared: PreparedProjectCommand,
  toolCallId: string,
  state: ProjectCommandInvocationState,
  ctx: ProjectCommandToolContext,
): Promise<AgentToolResult<ProjectCommandOutputDetails>> {
  const inspection = inspectResultCache(
    prepared.definition,
    prepared.relevantInputs,
    state.resultFingerprint,
    state.logicalRequestKey,
    state.forced,
    cache,
    prepared.requestSignal,
    getContextSessionId(ctx),
    state.beforeSnapshot,
  );
  state.cacheDecision = inspection.decision;

  if (inspection.entry !== undefined && inspection.beforeSnapshot !== undefined) {
    setCachedInvocationState(state, inspection.entry.details);
    return result({
      ...inspection.entry.details,
      ...invocationMetadataForState(toolCallId, state, {
        cacheDecision: "hit",
        reused: true,
        forced: false,
        producerInvocationId: inspection.entry.producerInvocationId,
      }),
    });
  }

  state.executionStartedAt = performance.now();
  const executed = await executeWithCache(
    executor,
    prepared.resolved,
    prepared.projectPath,
    prepared.requestSignal,
    cache,
    inspection,
    prepared.relevantInputs,
    state.resultFingerprint,
    stateSnapshotter,
  );
  state.cacheDecision = executed.decision;
  setOutcomeInvocationState(state, prepared.definition, executed.outcome);
  if (executed.canStore) state.producerInvocationId = toolCallId;
  const metadata = invocationMetadataForState(toolCallId, state);
  const details = outputDetails(
    prepared.identity,
    prepared.projectPath,
    prepared.resolved,
    executed.outcome,
    metadata,
  );
  storeResult(cache, inspection, state.resultFingerprint, executed, details, toolCallId);
  if (isAbortedOutcome(executed.outcome, prepared.requestSignal)) {
    throw cancellationError(cancellationOutputDetails(details));
  }
  if (isFailedOutcome(prepared.resolved, executed.outcome)) {
    throw createExecutionFailure(
      prepared.identity,
      prepared.projectPath,
      prepared.resolved,
      executed.outcome,
      metadata,
    );
  }
  return result(details);
}

export function createProjectCommandExecute<
  const Definitions extends readonly ProjectCommandDefinition[],
>(
  policy: PolicyStore,
  executor: ProjectCommandExecutor,
  resolver: ProjectCommandResolver,
  capturedDefinitions: Definitions,
  byId: ReadonlyMap<string, ProjectCommandDefinition>,
  relevantInputDiscovery: ProjectCommandRelevantInputDiscovery = createDefaultRelevantInputDiscovery(),
  stateSnapshotter: ProjectCommandStateSnapshotter = snapshotProjectCommandRelevantInputs,
  cache: ProjectCommandResultCache = createProjectCommandResultCache(),
  invocationOptions: ProjectCommandInvocationOptions = {},
): ProjectCommandExecute<Definitions> {
  return async (toolCallId, rawParams, signal, _onUpdate, ctx) => {
    const state = createInvocationState(performance.now());
    try {
      const prepared = await prepareProjectCommand(
        policy,
        resolver,
        ctx,
        rawParams,
        signal,
        capturedDefinitions,
        byId,
        relevantInputDiscovery,
        stateSnapshotter,
        state,
      );
      return await executePreparedProjectCommand(
        executor,
        cache,
        stateSnapshotter,
        prepared,
        toolCallId,
        state,
        ctx,
      );
    } catch (error) {
      if (error instanceof ProjectCommandToolError) {
        state.resultCategory = error.contract.category;
        state.executed = error.contract.executed;
        if (error.contract.code === "cancelled") state.status = "cancelled";
        if (error.contract.code === "executor-failure") state.cacheDecision = "ineligible";
        throw enrichToolError(error, invocationMetadataForState(toolCallId, state));
      }
      throw error;
    } finally {
      recordInvocation(
        invocationOptions.recorder,
        invocationOptions.schemaHash,
        toolCallId,
        ctx,
        state,
      );
    }
  };
}
