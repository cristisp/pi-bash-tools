import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  createAuthorizationOutcomeObserver,
  type AuthorizationOutcomeObserver,
  type AuthorizationOutcomeRecorder,
} from "../../observability/authorization-outcome.ts";
import {
  createProjectCommandInvocationMeasurements,
  recordProjectCommandInvocation,
  redactProjectCommandParameters,
  type ProjectCommandInvocationLookupMetadata,
  type ProjectCommandInvocationLookupOutcome,
  type ProjectCommandInvocationOutputMetadata,
  type ProjectCommandInvocationReason,
  type ProjectCommandInvocationRecorder,
} from "../../observability/project-command-invocation.ts";
import type { AuthorizationRetryTracker } from "../authorization-retry.ts";
import { authorizeOrPrompt, type AuthorizationErrorKind } from "../authorization.ts";
import { awaitWithAbort } from "../await-with-abort.ts";
import {
  createToolErrorContract,
  withToolErrorContract,
  type ResultCategory,
  type ToolErrorContract,
} from "../errors.ts";
import { findProjectCommandPolicyDecision } from "../policy/decisions.ts";
import type { CommandIdentity, PolicyStore } from "../policy/types.ts";
import {
  createProjectCommandDiskResultCache,
  createProjectCommandResultCache,
  type ProjectCommandCacheDecision,
  type ProjectCommandResultCache,
  type ProjectCommandResultCacheEntry,
} from "./cache.ts";
import { projectCommandResultCategory } from "./categories.ts";
import { definedObjectProperties } from "./defined-properties.ts";
import {
  getProjectCommandReusePolicy,
  projectCommandIdentity,
  type ProjectCommandDefinition,
} from "./definitions.ts";
import {
  createProjectCommandEvidenceRecord,
  type ProjectCommandEvidenceProvenance,
  type ProjectCommandEvidencePublication,
  type ProjectCommandEvidenceRecord,
  type ProjectCommandEvidenceStore,
} from "./evidence.ts";
import type { ProjectCommandExecutionOutcome } from "./execution.ts";
import {
  createProjectCommandLogicalRequestKey,
  createProjectCommandResultFingerprint,
  projectCommandPolicyId,
  PROJECT_COMMAND_RESULT_FINGERPRINT_VERSION,
} from "./fingerprint.ts";
import { projectCommandModelContent } from "./model-content.ts";
import { projectCommandMutatesWorkspace } from "./mutability.ts";
import { createNodeProjectRelevantInputDiscovery } from "./node/relevant-inputs.ts";
import {
  effectiveOrchestrationFlowId,
  readProjectCommandOrchestrationContext,
  type ProjectCommandOrchestrationContext,
} from "./orchestration.ts";
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
import {
  canonicalProjectCommandRelevantInputs,
  type ProjectCommandRelevantInputDiscovery,
  type ProjectCommandRelevantInputDiscoveryRequest,
  type ProjectCommandRelevantInputs,
} from "./relevant-inputs.ts";
import type {
  ProjectCommandRepositoryState,
  ProjectCommandRepositoryStateReader,
} from "./repository-state.ts";
import { ProjectCommandResolutionError, isProjectCommandResolutionError } from "./resolution.ts";
import type { ProjectCommandResolver, ResolvedProjectCommand } from "./resolution/types.ts";
import {
  cancellationError,
  invalidRequest,
  ProjectCommandToolError,
  type ProjectCommandInputFor,
  validateProjectCommandInput,
} from "./schema.ts";
import {
  equalProjectCommandStateSnapshots,
  projectCommandStateSnapshotDigest,
  snapshotProjectCommandRelevantInputs,
  type ProjectCommandStateSnapshot,
  type ProjectCommandStateSnapshotter,
} from "./state-snapshot.ts";

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
  readonly repositoryStateReader?: ProjectCommandRepositoryStateReader;
  readonly evidence?: ProjectCommandEvidenceStore;
  readonly authorizationOutcomeRecorder?: AuthorizationOutcomeRecorder;
  readonly authorizationRetryTracker?: AuthorizationRetryTracker;
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
    content: [{ type: "text", text: JSON.stringify(projectCommandModelContent(details)) }],
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
  readonly evidenceRef?: string;
  readonly covers?: readonly string[];
  readonly publication?: ProjectCommandEvidencePublication;
  readonly provenance?: ProjectCommandEvidenceProvenance;
  readonly repositoryState?: ProjectCommandRepositoryState;
  readonly recordedRepositoryState?: ProjectCommandRepositoryState;
  readonly currentRepositoryState?: ProjectCommandRepositoryState;
  readonly repositoryStateStatus?: "matches" | "mismatch" | "unreadable";
  readonly coercions?: readonly string[];
  readonly mutating?: boolean;
  readonly concurrentExecutions?: number;
  readonly stateDrift?: boolean;
  readonly sharedExecution?: boolean;
  readonly authFingerprint?: string;
  readonly policyId?: string;
  readonly reusePolicyId?: string;
  readonly resultFingerprint?: string;
  readonly relevantInputs?: ProjectCommandRelevantInputs;
  readonly producerInvocationId?: string;
  readonly producerScope?: "session" | "flow";
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
      ["evidenceRef", options.evidenceRef],
      ["covers", options.covers],
      ["publication", options.publication],
      ["provenance", options.provenance],
      ["repositoryState", options.repositoryState],
      ["recordedRepositoryState", options.recordedRepositoryState],
      ["currentRepositoryState", options.currentRepositoryState],
      ["repositoryStateStatus", options.repositoryStateStatus],
      ["coercions", options.coercions],
      ["mutating", options.mutating],
      ["concurrentExecutions", options.concurrentExecutions],
      ["stateDrift", options.stateDrift],
      ["sharedExecution", options.sharedExecution],
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
      ["producerScope", options.producerScope],
    ]),
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOptionalForce(
  value: unknown,
): value is ProjectCommandRequestParameters & { readonly force?: boolean } {
  return (
    isRecord(value) &&
    typeof value.commandId === "string" &&
    (!("force" in value) || typeof value.force === "boolean")
  );
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

function stripEvidenceParameters(
  params: ProjectCommandRequestParameters,
): ProjectCommandRequestParameters {
  const {
    covers: _covers,
    publish: _publish,
    coercions: _coercions,
    ...resolutionParameters
  } = params;
  return resolutionParameters;
}

async function resolveCommandForTool(
  resolver: ProjectCommandResolver,
  definition: ProjectCommandDefinition,
  projectPath: string,
  signal: AbortSignal | undefined,
  params: ProjectCommandRequestParameters,
  definitions: readonly ProjectCommandDefinition[],
): Promise<ResolvedProjectCommand> {
  try {
    return await resolver(definition, projectPath, signal, stripEvidenceParameters(params));
  } catch (error) {
    if (error instanceof ProjectCommandToolError && error.name === "AbortError") {
      throw error;
    }
    if (signal?.aborted) {
      throw commandCancellationError();
    }
    if (isProjectCommandResolutionError(error)) {
      throw createResolutionFailure(params, error, definitions);
    }
    throw createResolutionFailure(
      params,
      new ProjectCommandResolutionError("probe", "resolution-failure"),
      definitions,
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
  "unchanged-retry":
    "Project command was already denied for this identical request; change the request or ask the user to approve it explicitly",
};

function authorizationContract(
  kind: Exclude<AuthorizationErrorKind, "cancelled" | "dismissed">,
): ToolErrorContract {
  const blocked =
    kind === "denied" ||
    kind === "denied-once" ||
    kind === "not-authorized" ||
    kind === "unsafe-global" ||
    kind === "unchanged-retry";
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

async function loadPolicyObserved(
  policy: PolicyStore,
  cwd: string,
  signal: AbortSignal | undefined,
  observe: AuthorizationOutcomeObserver | undefined,
): Promise<Awaited<ReturnType<PolicyStore["load"]>>> {
  try {
    return await loadPolicy(policy, cwd, signal);
  } catch (error) {
    const cancelled =
      error instanceof ProjectCommandToolError && error.contract.code === "cancelled";
    if (!cancelled) {
      observe?.({
        outcome: "policy-load-failure",
        decisionPersisted: false,
        promptEmitted: false,
        promptWaitMs: 0,
      });
    }
    throw error;
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
  observe: AuthorizationOutcomeObserver | undefined,
  retryTracker: AuthorizationRetryTracker | undefined,
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
    reload: () => policy.load(ctx.cwd),
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
    observe,
    retry:
      retryTracker === undefined
        ? undefined
        : {
            tracker: retryTracker,
            surface: "project-command",
            sessionId: getContextSessionId(ctx),
            fingerprint: identity.fingerprint,
          },
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

function createDefaultProjectCommandResultCache(): ProjectCommandResultCache {
  const flowId = effectiveOrchestrationFlowId(readProjectCommandOrchestrationContext());
  if (flowId !== undefined) {
    return createProjectCommandDiskResultCache({ scopeKey: flowId });
  }
  return createProjectCommandResultCache();
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
  readonly producerSessionId: string | undefined;
  readonly producerRole: string | undefined;
  readonly flowId: string | undefined;
  readonly producerScope: "session" | "flow" | undefined;
  readonly repositoryState: ProjectCommandRepositoryState | undefined;
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
  producerScope: "session" | "flow" | undefined,
  repositoryState: ProjectCommandRepositoryState | undefined,
  flowId: string | undefined,
  projectPath: string,
): boolean {
  return (
    resultFingerprint !== undefined &&
    logicalRequestKey !== undefined &&
    relevantInputs !== undefined &&
    beforeSnapshot !== undefined &&
    requestSessionId !== undefined &&
    getProjectCommandReusePolicy(definition) !== "never" &&
    (producerScope !== "flow" ||
      (repositoryState !== undefined && flowId !== undefined && isAbsolute(projectPath)))
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

function flowProvenanceMatches(
  entry: ProjectCommandResultCacheEntry,
  flowId: string | undefined,
  projectPath: string,
  repositoryState: ProjectCommandRepositoryState | undefined,
  beforeSnapshot: ProjectCommandStateSnapshot,
): boolean {
  const provenance = entry.provenance;
  return (
    flowId !== undefined &&
    repositoryState !== undefined &&
    provenance !== undefined &&
    provenance.flowId === flowId &&
    provenance.repositoryIdentity === repositoryState.repositoryIdentity &&
    provenance.workingDirectory === projectPath &&
    provenance.head === repositoryState.head &&
    provenance.dirtyFilesDigest === repositoryState.dirtyFilesDigest &&
    provenance.snapshotDigest === projectCommandStateSnapshotDigest(beforeSnapshot)
  );
}

function invalidateStaleEntry(
  cache: ProjectCommandResultCache,
  sessionId: string,
  logicalRequestKey: string,
  resultFingerprint: string,
  beforeSnapshot: ProjectCommandStateSnapshot,
  producerScope: "session" | "flow" | undefined,
  flowId: string | undefined,
  projectPath: string,
  repositoryState: ProjectCommandRepositoryState | undefined,
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
      equalProjectCommandStateSnapshots(beforeSnapshot, entry.snapshot) &&
      (producerScope !== "flow" ||
        flowProvenanceMatches(entry, flowId, projectPath, repositoryState, beforeSnapshot)))
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
  producerScope: "session" | "flow" | undefined,
  flowId: string | undefined,
  projectPath: string,
  repositoryState: ProjectCommandRepositoryState | undefined,
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
    producerScope,
    flowId,
    projectPath,
    repositoryState,
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
  producerScope: "session" | "flow" | undefined,
  flowId: string | undefined,
  producerRole: string | undefined,
  projectPath: string,
  repositoryState: ProjectCommandRepositoryState | undefined,
): CacheInspection {
  const cacheSessionId =
    producerScope === "flow" && flowId !== undefined ? flowId : requestSessionId;
  const eligible = cacheIsEligible(
    definition,
    relevantInputs,
    resultFingerprint,
    logicalRequestKey,
    beforeSnapshot,
    requestSessionId,
    producerScope,
    repositoryState,
    flowId,
    projectPath,
  );
  if (!eligible || resultFingerprint === undefined || logicalRequestKey === undefined) {
    return {
      sessionId: cacheSessionId,
      producerSessionId: requestSessionId,
      producerRole,
      flowId,
      producerScope,
      repositoryState,
      logicalRequestKey,
      eligible: false,
      decision: forced ? "forced" : "ineligible",
    };
  }
  if (
    beforeSnapshot === undefined ||
    requestSessionId === undefined ||
    cacheSessionId === undefined
  ) {
    return {
      sessionId: cacheSessionId,
      producerSessionId: requestSessionId,
      producerRole,
      flowId,
      producerScope,
      repositoryState,
      logicalRequestKey,
      eligible: false,
      decision: "ineligible",
    };
  }
  const inspected = inspectCacheEntry(
    cache,
    cacheSessionId,
    logicalRequestKey,
    resultFingerprint,
    beforeSnapshot,
    forced,
    producerScope,
    flowId,
    projectPath,
    repositoryState,
  );
  throwIfRequestAborted(signal);
  return {
    sessionId: cacheSessionId,
    producerSessionId: requestSessionId,
    producerRole,
    flowId,
    producerScope,
    repositoryState,
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
  projectPath: string,
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
  const provenance =
    inspection.producerScope === "flow" &&
    inspection.producerSessionId !== undefined &&
    inspection.flowId !== undefined &&
    inspection.repositoryState !== undefined &&
    isAbsolute(projectPath)
      ? {
          producerSessionId: inspection.producerSessionId,
          ...(inspection.producerRole === undefined
            ? {}
            : { producerRole: inspection.producerRole }),
          flowId: inspection.flowId,
          repositoryIdentity: inspection.repositoryState.repositoryIdentity,
          workingDirectory: projectPath,
          head: inspection.repositoryState.head,
          dirtyFilesDigest: inspection.repositoryState.dirtyFilesDigest,
          snapshotDigest: projectCommandStateSnapshotDigest(executed.afterSnapshot),
          writeTimestamp: Date.now(),
        }
      : undefined;
  cache.set(inspection.sessionId, {
    logicalRequestKey: inspection.logicalRequestKey,
    resultFingerprint,
    details,
    snapshot: executed.afterSnapshot,
    producerInvocationId,
    ...(provenance === undefined ? {} : { provenance }),
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

function evidenceStorageFlowId(state: ProjectCommandInvocationState): string | undefined {
  return state.producerScope === "flow" ? state.flowId : undefined;
}

function withEvidencePublication(
  evidence: ProjectCommandEvidenceStore,
  record: ProjectCommandEvidenceRecord,
  details: ProjectCommandOutputDetails,
  state: ProjectCommandInvocationState,
): ProjectCommandOutputDetails {
  const storageFlowId = evidenceStorageFlowId(state);
  if (!evidence.set(record, storageFlowId)) {
    state.evidenceRef = undefined;
    return details;
  }
  if (state.requestedPublicationFlowId !== undefined) {
    const targetFlowId = state.requestedPublicationFlowId;
    const publicationCandidate: ProjectCommandEvidencePublication = {
      scope: "flow",
      flowId: targetFlowId,
      published: true,
    };
    const published = evidence.publish(
      record.ref,
      targetFlowId,
      state.repositoryState?.repositoryIdentity,
      publicationCandidate,
    );
    const publication: ProjectCommandEvidencePublication = published
      ? publicationCandidate
      : {
          ...publicationCandidate,
          published: false,
          error: "Evidence publication was not available from the producer scope.",
        };
    state.publication = publication;
    const root = storageFlowId === undefined ? evidence.getByRef(record.ref) : undefined;
    if (root !== undefined) {
      evidence.set(
        Object.freeze({
          ...root,
          details: Object.freeze({ ...root.details, publication }),
          publication,
        }),
      );
    }
  }
  return {
    ...details,
    ref: record.ref,
    covers: record.covers,
    ...(record.repositoryState === undefined
      ? {}
      : {
          repositoryState: record.repositoryState,
          recordedRepositoryState: record.repositoryState,
        }),
    ...(record.provenance === undefined ? {} : { provenance: record.provenance }),
    ...(state.publication === undefined ? {} : { publication: state.publication }),
  };
}

function storeEvidence(
  evidence: ProjectCommandEvidenceStore | undefined,
  details: ProjectCommandOutputDetails,
  state: ProjectCommandInvocationState,
  toolCallId: string,
): ProjectCommandOutputDetails {
  if (evidence === undefined || !details.executed) return details;
  const provenance: ProjectCommandEvidenceProvenance = {
    ...(state.provenance ?? { scope: state.producerScope ?? "session" }),
    producerInvocationId: toolCallId,
  };
  state.producerInvocationId = state.producerInvocationId ?? toolCallId;
  state.provenance = provenance;
  const record = createProjectCommandEvidenceRecord(details, {
    repositoryState: state.repositoryState,
    covers: state.covers,
    producerScope: state.producerScope ?? "session",
    ...(state.flowId === undefined ? {} : { flowId: state.flowId }),
    ...(state.producerRole === undefined ? {} : { producerRole: state.producerRole }),
    ...(state.delegationId === undefined ? {} : { producerDelegationId: state.delegationId }),
    provenance,
  });
  state.evidenceRef = record.ref;
  return withEvidencePublication(evidence, record, details, state);
}

interface ProjectCommandInvocationState {
  readonly startedAt: number;
  preparationEntered: boolean;
  authorizationStartedAt: number | undefined;
  authorizationFinishedAt: number | undefined;
  queueStartedAt: number | undefined;
  queueFinishedAt: number | undefined;
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
  producerScope: "session" | "flow" | undefined;
  flowId: string | undefined;
  delegationId: string | undefined;
  producerRole: string | undefined;
  repositoryState: ProjectCommandRepositoryState | undefined;
  currentRepositoryState: ProjectCommandRepositoryState | undefined;
  evidenceRef: string | undefined;
  covers: readonly string[] | undefined;
  coercions: readonly string[] | undefined;
  mutating: boolean | undefined;
  concurrentExecutions: number | undefined;
  stateDrift: boolean | undefined;
  sharedExecution: boolean;
  publication: ProjectCommandEvidencePublication | undefined;
  requestedPublicationFlowId: string | undefined;
  provenance: ProjectCommandEvidenceProvenance | undefined;
  repositoryStateStatus: "matches" | "mismatch" | "unreadable" | undefined;
  commandId: string | undefined;
  redactedParameters: Readonly<Record<string, unknown>> | undefined;
  resultCategory: ResultCategory | undefined;
  status: ProjectCommandExecutionOutcome["status"] | undefined;
  executed: boolean;
  output: ProjectCommandInvocationOutputMetadata | undefined;
  lookup: ProjectCommandInvocationLookupMetadata | undefined;
}

function createInvocationState(
  startedAt: number,
  orchestration: ProjectCommandOrchestrationContext,
): ProjectCommandInvocationState {
  return {
    startedAt,
    preparationEntered: false,
    authorizationStartedAt: undefined,
    authorizationFinishedAt: undefined,
    queueStartedAt: undefined,
    queueFinishedAt: undefined,
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
    producerScope: orchestration.orchestrated ? orchestration.effectiveScope : undefined,
    flowId: orchestration.flowId,
    delegationId: orchestration.delegationId,
    producerRole: orchestration.role,
    repositoryState: undefined,
    currentRepositoryState: undefined,
    evidenceRef: undefined,
    covers: undefined,
    coercions: undefined,
    mutating: undefined,
    concurrentExecutions: undefined,
    stateDrift: undefined,
    sharedExecution: false,
    publication: undefined,
    requestedPublicationFlowId: undefined,
    provenance: undefined,
    repositoryStateStatus: undefined,
    commandId: undefined,
    redactedParameters: undefined,
    resultCategory: undefined,
    status: undefined,
    executed: false,
    output: undefined,
    lookup: undefined,
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

function cachedProjectCommandResult(
  inspection: CacheInspection,
  toolCallId: string,
  state: ProjectCommandInvocationState,
): AgentToolResult<ProjectCommandOutputDetails> | undefined {
  if (inspection.entry === undefined || inspection.beforeSnapshot === undefined) {
    return undefined;
  }
  setCachedInvocationState(state, inspection.entry.details);
  return result({
    ...inspection.entry.details,
    ...invocationMetadataForState(toolCallId, state, {
      cacheDecision: "hit",
      reused: true,
      forced: false,
      producerInvocationId: inspection.entry.producerInvocationId,
      producerScope: inspection.entry.provenance === undefined ? undefined : "flow",
    }),
  });
}

async function reconcileRepositoryState(
  repositoryStateReader: ProjectCommandRepositoryStateReader | undefined,
  projectPath: string,
  signal: AbortSignal | undefined,
  state: ProjectCommandInvocationState,
): Promise<void> {
  if (repositoryStateReader === undefined) return;
  try {
    state.currentRepositoryState = await repositoryStateReader(projectPath, signal);
  } catch {
    if (signal?.aborted) throw commandCancellationError();
    state.currentRepositoryState = undefined;
  }
  state.repositoryStateStatus = repositoryStateStatus(
    state.repositoryState,
    state.currentRepositoryState,
  );
  state.stateDrift =
    state.repositoryState !== undefined &&
    state.currentRepositoryState !== undefined &&
    !repositoryStatesEqual(state.repositoryState, state.currentRepositoryState);
}

function finalizeExecutedProjectCommand(
  cache: ProjectCommandResultCache,
  evidence: ProjectCommandEvidenceStore | undefined,
  inspection: CacheInspection,
  resultFingerprint: string | undefined,
  executed: ExecutedWithCache,
  prepared: PreparedProjectCommand,
  toolCallId: string,
  state: ProjectCommandInvocationState,
): ProjectCommandOutputDetails {
  if (executed.canStore) state.producerInvocationId = toolCallId;
  const metadata = invocationMetadataForState(toolCallId, state);
  const details = outputDetails(
    prepared.identity,
    prepared.projectPath,
    prepared.resolved,
    executed.outcome,
    metadata,
  );
  storeResult(
    cache,
    inspection,
    resultFingerprint,
    executed,
    details,
    prepared.projectPath,
    toolCallId,
  );
  return storeEvidence(evidence, details, state, toolCallId);
}

const EARLY_FAILURE_REASONS: Partial<Record<ResultCategory, ProjectCommandInvocationReason>> = {
  INVALID_REQUEST: "invalid-request",
  RESOLUTION_FAILURE: "resolution-failure",
  POLICY_FAILURE: "policy-failure",
  BLOCKED: "policy-failure",
  CANCELLED: "cancelled",
};

interface ProjectCommandSingleFlight {
  readonly promise: Promise<ProjectCommandOutputDetails>;
  active: number;
}

const PROJECT_COMMAND_SINGLE_FLIGHTS = new Map<string, ProjectCommandSingleFlight>();

function projectCommandSingleFlightKey(
  prepared: PreparedProjectCommand,
  state: ProjectCommandInvocationState,
  evidence: ProjectCommandEvidenceStore | undefined,
): string | undefined {
  if (
    evidence === undefined ||
    state.forced ||
    state.mutating === true ||
    state.logicalRequestKey === undefined
  ) {
    return undefined;
  }
  return [
    state.producerScope ?? "session",
    state.flowId ?? "",
    prepared.projectPath,
    prepared.identity.fingerprint,
    state.logicalRequestKey,
    state.repositoryState?.repositoryIdentity ?? "",
    state.repositoryState?.head ?? "",
    state.repositoryState?.dirtyFilesDigest ?? "",
    prepared.resolved.scriptHash ?? "",
  ].join("\u0000");
}

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
      ...(state.preparationEntered
        ? {
            preparationDurationMs: elapsedMilliseconds(
              state.startedAt,
              state.authorizationStartedAt ?? finishedAt,
            ),
          }
        : {}),
      ...(state.authorizationStartedAt === undefined || state.authorizationFinishedAt === undefined
        ? {}
        : {
            authorizationDurationMs: elapsedMilliseconds(
              state.authorizationStartedAt,
              state.authorizationFinishedAt,
            ),
          }),
      ...(state.queueStartedAt === undefined || state.queueFinishedAt === undefined
        ? {}
        : { queueDurationMs: elapsedMilliseconds(state.queueStartedAt, state.queueFinishedAt) }),
      output: state.output,
      measurements: createProjectCommandInvocationMeasurements(
        state.cacheDecision,
        state.reused,
        state.output,
      ),
      producerScope: state.producerScope,
      flowId: state.flowId,
      delegationId: state.delegationId,
      role: state.producerRole,
      ref: state.evidenceRef,
      repositoryState:
        state.repositoryState === undefined
          ? undefined
          : {
              ...state.repositoryState,
              readable: true,
              ...(state.repositoryStateStatus === undefined
                ? {}
                : { stateMatchesCurrent: state.repositoryStateStatus === "matches" }),
            },
      publication: state.publication,
      lookup: state.lookup,
      coercions: state.coercions,
      mutating: state.mutating,
      concurrentExecutions: state.concurrentExecutions,
      stateDrift: state.stateDrift,
      sharedExecution: state.sharedExecution,
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
      producerScope: state.producerScope,
      provenance: state.provenance,
      repositoryState: state.repositoryState,
      recordedRepositoryState: state.repositoryState,
      currentRepositoryState: state.currentRepositoryState,
      repositoryStateStatus: state.repositoryStateStatus,
      evidenceRef: state.evidenceRef,
      covers: state.covers,
      coercions: state.coercions,
      mutating: state.mutating,
      concurrentExecutions: state.concurrentExecutions,
      stateDrift: state.stateDrift,
      sharedExecution: state.sharedExecution,
      publication: state.publication,
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
  repositoryStateReader: ProjectCommandRepositoryStateReader | undefined,
  state: ProjectCommandInvocationState,
  toolCallId: string,
  authorizationOutcomeRecorder: AuthorizationOutcomeRecorder | undefined,
  authorizationRetryTracker: AuthorizationRetryTracker | undefined,
): Promise<PreparedProjectCommand> {
  const validatedParams = validateProjectCommandInput(rawParams, capturedDefinitions);
  if (!hasOptionalForce(validatedParams)) {
    throw invalidRequest();
  }
  state.forced = validatedParams.force === true;
  const params = stripForce(validatedParams);
  state.commandId = params.commandId;
  state.redactedParameters = redactProjectCommandParameters(params);
  state.covers = Array.isArray(params.covers) ? params.covers : undefined;
  state.coercions = Array.isArray(params.coercions) ? params.coercions : undefined;
  state.requestedPublicationFlowId =
    isRecord(params.publish) && typeof params.publish.flowId === "string"
      ? params.publish.flowId
      : undefined;
  state.provenance = {
    scope: state.producerScope ?? "session",
    ...(state.flowId === undefined ? {} : { flowId: state.flowId }),
    ...(getContextSessionId(executorContext) === undefined
      ? {}
      : { producerSessionId: getContextSessionId(executorContext) }),
    ...(state.producerRole === undefined ? {} : { producerRole: state.producerRole }),
    ...(state.delegationId === undefined ? {} : { producerDelegationId: state.delegationId }),
  };
  const definition = byId.get(params.commandId);
  if (definition === undefined) throw invalidRequest("commandId");
  const observe = createAuthorizationOutcomeObserver({
    surface: "project-command",
    commandId: state.commandId,
    recorder: authorizationOutcomeRecorder,
    sessionId: getContextSessionId(executorContext),
    toolCallId,
    mode: executorContext.mode,
    flowId: effectiveOrchestrationFlowId(readProjectCommandOrchestrationContext()),
  });
  const requestSignal = signal ?? executorContext.signal;
  const loaded = await loadPolicyObserved(policy, executorContext.cwd, requestSignal, observe);
  state.reusePolicyId = getProjectCommandReusePolicy(definition);
  const resolved = await resolveCommandForTool(
    resolver,
    definition,
    loaded.projectPath,
    requestSignal,
    params,
    capturedDefinitions,
  );
  state.mutating = projectCommandMutatesWorkspace(definition, resolved);
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
  state.authorizationStartedAt = performance.now();
  try {
    await authorizeCommand(
      policy,
      loaded,
      definition,
      identity,
      resolved,
      executorContext,
      requestSignal,
      observe,
      authorizationRetryTracker,
    );
  } finally {
    state.authorizationFinishedAt = performance.now();
  }
  throwIfRequestAborted(requestSignal);
  const authorizedPolicy = await loadPolicyObserved(
    policy,
    executorContext.cwd,
    requestSignal,
    observe,
  );
  state.policyId = projectCommandPolicyId(authorizedPolicy);
  state.beforeSnapshot =
    relevantInputs === undefined
      ? undefined
      : await takeStateSnapshot(stateSnapshotter, loaded.projectPath, relevantInputs);
  if (repositoryStateReader !== undefined) {
    state.repositoryState = await repositoryStateReader(loaded.projectPath, requestSignal);
  }
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

function repositoryStatesEqual(
  left: ProjectCommandRepositoryState | undefined,
  right: ProjectCommandRepositoryState | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.repositoryIdentity === right.repositoryIdentity &&
    left.head === right.head &&
    left.dirtyFilesDigest === right.dirtyFilesDigest
  );
}

function repositoryStateStatus(
  recorded: ProjectCommandRepositoryState | undefined,
  current: ProjectCommandRepositoryState | undefined,
): "matches" | "mismatch" | "unreadable" {
  if (recorded === undefined || current === undefined) return "unreadable";
  return recorded.repositoryIdentity === current.repositoryIdentity &&
    recorded.head === current.head &&
    recorded.dirtyFilesDigest === current.dirtyFilesDigest
    ? "matches"
    : "mismatch";
}

function evidenceLookupFlowId(
  requested: string | undefined,
  orchestration: ProjectCommandOrchestrationContext,
): string | undefined {
  if (requested !== undefined) {
    return orchestration.effectiveScope === "flow" && orchestration.flowId === requested
      ? requested
      : undefined;
  }
  return effectiveOrchestrationFlowId(orchestration);
}

function evidenceNotFound(ref: string, flowId: string | undefined): ProjectCommandToolError {
  const scope = flowId === undefined ? "the process-local root-session store" : `flow ${flowId}`;
  return new ProjectCommandToolError(
    `Project command evidence ref ${ref} not found in ${scope}; evidence refs are non-replayable and process-scoped.`,
  );
}

function evidenceLookupFailureState(
  state: ProjectCommandInvocationState,
  outcome: ProjectCommandInvocationLookupOutcome | undefined,
): void {
  state.lookup = {
    attempted: true,
    success: false,
    failure: "not-found",
    ...(outcome === undefined ? {} : { outcome }),
  };
}

async function executeEvidenceLookup(
  evidence: ProjectCommandEvidenceStore,
  repositoryStateReader: ProjectCommandRepositoryStateReader | undefined,
  ref: string,
  requestedFlowId: string | undefined,
  signal: AbortSignal | undefined,
  state: ProjectCommandInvocationState,
): Promise<AgentToolResult<ProjectCommandOutputDetails>> {
  const orchestration = readProjectCommandOrchestrationContext();
  if (
    requestedFlowId !== undefined &&
    (orchestration.effectiveScope !== "flow" || orchestration.flowId !== requestedFlowId)
  ) {
    evidenceLookupFailureState(state, "unauthorized-flow");
    throw evidenceNotFound(ref, requestedFlowId);
  }
  const flowId = evidenceLookupFlowId(requestedFlowId, orchestration);
  const record = evidence.getByRef(ref, flowId);
  if (record === undefined) {
    const outcome = evidence.lookupOutcome?.(ref, flowId);
    evidenceLookupFailureState(state, outcome === "corrupt" ? "corrupt" : "not-found");
    throw evidenceNotFound(ref, flowId);
  }
  state.lookup = { attempted: true, success: true, outcome: "success" };
  throwIfRequestAborted(signal);

  let currentRepositoryState: ProjectCommandRepositoryState | undefined;
  if (repositoryStateReader !== undefined) {
    try {
      currentRepositoryState = await repositoryStateReader(
        record.details.scope.projectPath,
        signal,
      );
    } catch {
      if (signal?.aborted) throw commandCancellationError();
    }
  }
  const status = repositoryStateStatus(record.repositoryState, currentRepositoryState);
  const provenance =
    record.provenance ??
    (record.producerScope === undefined
      ? undefined
      : {
          scope: record.producerScope,
          ...(record.flowId === undefined ? {} : { flowId: record.flowId }),
          ...(record.producerRole === undefined ? {} : { producerRole: record.producerRole }),
          ...(record.producerDelegationId === undefined
            ? {}
            : { producerDelegationId: record.producerDelegationId }),
          ...(record.details.producerInvocationId === undefined
            ? {}
            : { producerInvocationId: record.details.producerInvocationId }),
        });
  const details = {
    ...record.details,
    ref: record.ref,
    covers: record.covers,
    ...(record.repositoryState === undefined
      ? {}
      : {
          repositoryState: record.repositoryState,
          recordedRepositoryState: record.repositoryState,
        }),
    ...(currentRepositoryState === undefined ? {} : { currentRepositoryState }),
    repositoryStateStatus: status,
    ...(provenance === undefined ? {} : { provenance }),
    ...(record.publication === undefined ? {} : { publication: record.publication }),
  } satisfies ProjectCommandOutputDetails;
  state.commandId = record.details.commandId;
  state.redactedParameters = record.details.parameters;
  state.evidenceRef = record.ref;
  state.covers = record.covers;
  state.provenance = provenance;
  state.repositoryState = record.repositoryState;
  state.currentRepositoryState = currentRepositoryState;
  state.repositoryStateStatus = status;
  state.resultCategory = record.details.category;
  state.status = undefined;
  state.executed = false;
  state.publication = record.publication;
  return result(details);
}

async function executePreparedProjectCommandCore(
  executor: ProjectCommandExecutor,
  cache: ProjectCommandResultCache,
  evidence: ProjectCommandEvidenceStore | undefined,
  repositoryStateReader: ProjectCommandRepositoryStateReader | undefined,
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
    state.producerScope,
    state.flowId,
    state.producerRole,
    prepared.projectPath,
    state.repositoryState,
  );
  state.cacheDecision = inspection.decision;

  const cachedResult = cachedProjectCommandResult(inspection, toolCallId, state);
  if (cachedResult !== undefined) return cachedResult;

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
  await reconcileRepositoryState(
    repositoryStateReader,
    prepared.projectPath,
    prepared.requestSignal,
    state,
  );
  const evidencedDetails = finalizeExecutedProjectCommand(
    cache,
    evidence,
    inspection,
    state.resultFingerprint,
    executed,
    prepared,
    toolCallId,
    state,
  );
  if (isAbortedOutcome(executed.outcome, prepared.requestSignal)) {
    throw cancellationError(cancellationOutputDetails(evidencedDetails));
  }
  if (isFailedOutcome(prepared.resolved, executed.outcome)) {
    throw createExecutionFailure(
      prepared.identity,
      prepared.projectPath,
      prepared.resolved,
      executed.outcome,
      invocationMetadataForState(toolCallId, state),
    );
  }
  return result(evidencedDetails);
}

async function executePreparedProjectCommand(
  executor: ProjectCommandExecutor,
  cache: ProjectCommandResultCache,
  evidence: ProjectCommandEvidenceStore | undefined,
  repositoryStateReader: ProjectCommandRepositoryStateReader | undefined,
  stateSnapshotter: ProjectCommandStateSnapshotter,
  prepared: PreparedProjectCommand,
  toolCallId: string,
  state: ProjectCommandInvocationState,
  ctx: ProjectCommandToolContext,
): Promise<AgentToolResult<ProjectCommandOutputDetails>> {
  const key = projectCommandSingleFlightKey(prepared, state, evidence);
  if (key === undefined) {
    return executePreparedProjectCommandCore(
      executor,
      cache,
      evidence,
      repositoryStateReader,
      stateSnapshotter,
      prepared,
      toolCallId,
      state,
      ctx,
    );
  }
  const existing = PROJECT_COMMAND_SINGLE_FLIGHTS.get(key);
  if (existing !== undefined) {
    existing.active += 1;
    state.sharedExecution = true;
    state.concurrentExecutions = existing.active;
    state.queueStartedAt = performance.now();
    try {
      const shared = await awaitWithAbort(
        existing.promise,
        prepared.requestSignal,
        commandCancellationError,
      );
      state.queueFinishedAt = performance.now();
      state.cacheDecision = shared.cacheDecision;
      state.resultCategory = shared.category;
      state.status = shared.status;
      state.executed = false;
      state.output = shared.output;
      state.evidenceRef = shared.ref;
      state.covers = shared.covers;
      state.provenance = shared.provenance;
      state.publication = shared.publication;
      state.repositoryState = shared.recordedRepositoryState ?? shared.repositoryState;
      state.currentRepositoryState = shared.currentRepositoryState;
      state.repositoryStateStatus = shared.repositoryStateStatus;
      state.stateDrift = shared.stateDrift;
      return result({
        ...shared,
        toolCallId,
        reused: false,
        executed: false,
        sharedExecution: true,
        concurrentExecutions: existing.active,
        durationMs: elapsedMilliseconds(state.startedAt, performance.now()),
        executionDurationMs: 0,
      });
    } finally {
      state.queueFinishedAt ??= performance.now();
      existing.active -= 1;
    }
  }
  const entry: ProjectCommandSingleFlight = {
    promise: Promise.resolve().then(async () => {
      const output = await executePreparedProjectCommandCore(
        executor,
        cache,
        evidence,
        repositoryStateReader,
        stateSnapshotter,
        prepared,
        toolCallId,
        state,
        ctx,
      );
      if (output.details !== undefined && state.concurrentExecutions !== undefined) {
        return {
          ...output.details,
          concurrentExecutions: state.concurrentExecutions,
        };
      }
      return output.details;
    }),
    active: 1,
  };
  state.concurrentExecutions = 1;
  PROJECT_COMMAND_SINGLE_FLIGHTS.set(key, entry);
  try {
    return result(await entry.promise);
  } finally {
    if (PROJECT_COMMAND_SINGLE_FLIGHTS.get(key) === entry) {
      PROJECT_COMMAND_SINGLE_FLIGHTS.delete(key);
    }
  }
}

export function projectCommandSingleFlightCountsForTesting(): ReadonlyMap<string, number> {
  return new Map([...PROJECT_COMMAND_SINGLE_FLIGHTS].map(([key, flight]) => [key, flight.active]));
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
  cache: ProjectCommandResultCache = createDefaultProjectCommandResultCache(),
  invocationOptions: ProjectCommandInvocationOptions = {},
): ProjectCommandExecute<Definitions> {
  return async (toolCallId, rawParams, signal, _onUpdate, ctx) => {
    const state = createInvocationState(
      performance.now(),
      readProjectCommandOrchestrationContext(),
    );
    try {
      const requestSignal = signal ?? ctx.signal;
      if (isRecord(rawParams) && "ref" in rawParams) {
        const validatedLookup = validateProjectCommandInput(rawParams, capturedDefinitions);
        const lookupRecord: Readonly<Record<string, unknown>> = isRecord(validatedLookup)
          ? validatedLookup
          : {};
        const lookupRef = typeof lookupRecord.ref === "string" ? lookupRecord.ref : undefined;
        if (lookupRef === undefined) {
          throw invalidRequest("ref");
        }
        if (invocationOptions.evidence === undefined) {
          throw evidenceNotFound(lookupRef, undefined);
        }
        return await executeEvidenceLookup(
          invocationOptions.evidence,
          invocationOptions.repositoryStateReader,
          lookupRef,
          typeof lookupRecord.flowId === "string" ? lookupRecord.flowId : undefined,
          requestSignal,
          state,
        );
      }
      state.preparationEntered = true;
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
        invocationOptions.repositoryStateReader,
        state,
        toolCallId,
        invocationOptions.authorizationOutcomeRecorder,
        invocationOptions.authorizationRetryTracker,
      );
      return await executePreparedProjectCommand(
        executor,
        cache,
        invocationOptions.evidence,
        invocationOptions.repositoryStateReader,
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
