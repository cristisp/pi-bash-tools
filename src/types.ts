import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import type { AgentScope } from './agents.ts';

export type HerdrStatus = 'unknown' | 'working' | 'idle' | 'blocked' | 'done';

export type BlockReason = 'approval' | 'steer';

export interface BlockEventInfo {
	label: string;
	blockReason: BlockReason;
	preview?: string;
	resolved?: boolean;
}

export type RegistryStatus = 'running' | 'done';

export type BudgetPolicy = 'steer' | 'abort';

export type BudgetMetric =
	| 'toolCalls'
	| 'discoveryCalls'
	| 'fullValidationPasses'
	| 'failedToolCalls'
	| 'repeatedReads'
	| 'outputTokens'
	| 'wallTimeMs';

export type BudgetOutcome = 'within' | 'steered' | 'report_only' | 'aborted';

export type BudgetPhase = 'discovery' | 'implementation' | 'finalization' | 'report';

export type BudgetCause =
	| 'discovery'
	| 'repeated_reads'
	| 'failed_calls'
	| 'tool_calls'
	| 'validation'
	| 'report_output'
	| 'finalization_reserve'
	| 'wall_time';

export interface RoleBudget {
	toolCalls: number;
	discoveryCalls: number;
	/** Worker-only discovery allowance before the first implementation tool call. */
	implementationDiscoveryCalls?: number;
	/** Tool calls reserved for the worker's final affected-test query, validation, and report. */
	finalizationReserveCalls?: number;
	/** Validation passes reserved for final-state evidence. */
	finalizationReserveValidationPasses?: number;
	fullValidationPasses: number;
	failedToolCalls: number;
	repeatedReads: number;
	outputTokens: number;
	wallTimeMs: number;
	budgetPolicy: BudgetPolicy;
}

export interface BudgetUsage {
	toolCalls: number;
	/** Calls this session made through `ctx.executeTool()` while another tool was running. */
	nestedToolCalls: number;
	discoveryCalls: number;
	fullValidationPasses: number;
	failedToolCalls: number;
	repeatedReads: number;
	/**
	 * Output tokens produced by turns that issued no tool call, i.e. the report prose the
	 * `outputTokens` limit governs. Tool-call arguments are bounded by the call budgets instead.
	 */
	outputTokens: number;
	/** Output tokens produced by turns that issued at least one tool call. Not limited. */
	toolArgumentTokens?: number;
	/**
	 * Reasoning/thinking output on report turns. Reported separately because a reasoning-heavy model
	 * must not spend the report contract on thinking; not limited.
	 */
	reasoningTokens?: number;
	wallTimeMs: number;
}

export interface BudgetBreach {
	metric: BudgetMetric;
	limit: number;
	observed: number;
	at: number;
}

export interface BudgetSummary {
	role: string;
	limits: RoleBudget;
	usage: BudgetUsage;
	outcome: BudgetOutcome;
	breaches: BudgetBreach[];
	steerIssued: boolean;
	reportOnly: boolean;
	/** Opaque provenance token for the automatic steer message emitted in this turn. */
	automaticSteerId?: string;
	/** Whether this child has attempted an implementation tool call. */
	implementationStarted?: boolean;
	/** Whether the worker-only pre-implementation discovery gate has blocked a call. */
	implementationGateReached?: boolean;
	/** Number of registry writes made by this child budget enforcer. */
	registryPersists?: number;
	/** Number of tool calls refused because another session held the repository write lock. */
	repositoryWriteLockRefusals?: number;
	/** Phase reached when this turn settled. */
	phase?: BudgetPhase;
	/** First material cause recorded for a stop or protected-phase refusal. */
	cause?: BudgetCause;
	/** Whether the worker entered its protected finalization window. */
	finalizationReady?: boolean;
	/** Whether the final validation was observed after the last accepted implementation change. */
	finalStateValidation?: boolean;
}

export type EvidenceScope = 'session' | 'flow';

/** How standard-role composition violations are handled before children are spawned. */
export type CompositionPolicy = 'warn' | 'enforce' | 'off';

export type CompositionRuleId = 'R1' | 'R2' | 'R3' | 'R4';
export type CompositionMode = 'single' | 'parallel' | 'chain';
export type CompositionAction = 'warn' | 'refuse';
export type CompositionVerdictKind = 'warning' | 'refusal';

/** Additive S4 preflight action; unlike CompositionAction this records clean and disabled decisions. */
export type S4CompositionAction = 'not_applicable' | 'allow' | 'warn' | 'refuse' | 'disabled';
export type S4DecisionSource = 'default' | 'override';
export type S4Lifecycle = 'settled' | 'failed' | 'aborted' | 'blocked' | 'abandoned' | 'unknown';
export type S4Quality = 'pass' | 'fail' | 'incomplete' | 'not_run' | 'unknown';
export type S4GuardrailStatus = 'pass' | 'fail' | 'unknown' | 'insufficient';
export type S4IndependentReviewStatus = 'pass' | 'fail' | 'pending' | 'unknown';
export type S4EscalationDirection = 'up' | 'down' | 'same' | 'unknown';

export type S4DirectionCounts = Record<S4EscalationDirection, number>;

export interface S4EscalationSignal {
	fromTier: number | null;
	toTier: number | null;
	direction: S4EscalationDirection;
}

/** Structured quality and lifecycle signals. Undefined/null values remain unknown to the analyzer. */
export interface S4QualitySignals {
	unresolvedOrAbandoned?: boolean | null;
	reviewerPass?: boolean | null;
	regressionAfterReviewPass?: boolean | null;
	escalation?: S4EscalationSignal;
	tier1DiscoveryFailure?: boolean | null;
	independentReviewStatus?: S4IndependentReviewStatus;
	componentStatusConsistent?: boolean;
}

/** One catalog rule observation for one real subagent preflight boundary. */
export interface S4CompositionObservation {
	ruleId: CompositionRuleId;
	eligible: boolean;
	compliant: boolean | null;
	action: S4CompositionAction;
	decisionSource: S4DecisionSource;
	reason: string;
	compositionBoundaryId: string;
	mode: CompositionMode;
	policy: CompositionPolicy;
	policyOverride?: CompositionPolicy;
	expectedChildCount: number;
}

/** All rule observations emitted before children are spawned (or a refusal is returned). */
export interface S4Preflight {
	v: 1;
	compositionBoundaryId: string;
	mode: CompositionMode;
	policy: CompositionPolicy;
	policyOverride?: CompositionPolicy;
	expectedChildCount: number;
	observations: S4CompositionObservation[];
}

export interface S4Correlation {
	flowId: string;
	taskId: string;
	delegationId: string;
	ledgerRevision: number;
	compositionBoundaryId: string;
	tier?: number;
}

/** Normalized child lifecycle and quality evidence correlated to one S4 boundary. */
export interface S4Outcome {
	v: 1;
	lifecycle: S4Lifecycle;
	quality: S4Quality;
	validationStatus: S4Quality;
	reviewStatus: S4Quality;
	budgetStatus: S4Quality;
	/** Independent review is distinct from the ordinary child review component. */
	independentReviewStatus: S4IndependentReviewStatus;
	qualitySignals: S4QualitySignals;
	correlation: S4Correlation;
}

export interface CompositionRuleDefinition {
	id: CompositionRuleId;
	role: 'validator' | 'reviewer' | 'worker';
	title: string;
	description: string;
	alternative: string;
}

/** The single source of truth used by enforcement, tool guidance, and the guide. */
export const COMPOSITION_RULES: readonly CompositionRuleDefinition[] = [
	{
		id: 'R1',
		role: 'validator',
		title: 'First validator',
		description: 'Use the worker verify ref.',
		alternative: 'Delegate later only when independent execution is needed.',
	},
	{
		id: 'R2',
		role: 'reviewer',
		title: 'Reviewer scopes',
		description: 'parallel fan-out reviewers need non-empty, disjoint scope.paths.',
		alternative: 'Assign disjoint paths or use one reviewer.',
	},
	{
		id: 'R3',
		role: 'validator',
		title: 'Validator scope',
		description: 'A second-tier or lower validator needs evidenceScope: "session".',
		alternative: 'Pass session scope or omit the validator.',
	},
	{
		id: 'R4',
		role: 'worker',
		title: 'Worker ordering',
		description: 'A third-tier worker needs a preceding planner.',
		alternative:
			'Use a sequential chain with a completed planner before the worker or use a lower tier.',
	},
];

export function compositionRulesText(compact = false): string {
	return COMPOSITION_RULES.map((rule) =>
		compact
			? `- ${rule.id} ${rule.title}`
			: `- ${rule.id} ${rule.title}: ${rule.description} ${rule.alternative}`,
	).join('\n');
}

export function compositionToolSummary(): string {
	return `Composition policy uses the configured policy for the standard subagent tool. Deliberate per-call overrides are available only through subagent_override, where compositionPolicy is required. enforce refuses violations, warn reports them and still spawns, and off disables these standard-role checks.\n${compositionRulesText()}`;
}

export interface CompositionVerdict {
	rule: CompositionRuleId;
	/** Machine action taken at the boundary. */
	action: CompositionAction;
	/** Human-readable equivalent of action for telemetry consumers. */
	verdict: CompositionVerdictKind;
	policy: CompositionPolicy;
	mode: CompositionMode;
	agent?: string;
	role?: string;
	tier?: number;
	scope?: ReviewScope;
	reason: string;
	compliantAlternative: string;
}

export type WorkflowMode = 'initial' | 'remediation';

export type ReviewMode = 'primary' | 'security' | 'validation' | 'remediation';

/** Normal handoffs carry identifiers and pointers; history is reacquired only when required. */
export type ContextMode = 'compact' | 'bounded-recovery' | 'full';

/** Full context is an explicit exception reserved for these bounded purposes. */
export type ContextReason =
	| 'normal'
	| 'remediation'
	| 'stale-evidence'
	| 'rejected-evidence'
	| 'ambiguous-evidence'
	| 'required-evidence'
	| 'audit'
	| 'integration'
	| 'recovery';

export interface ContextPolicy {
	mode: ContextMode;
	reason: ContextReason;
	/** Normal discovery must not preload the historical ledger or prior reports. */
	preloadHistory: boolean;
	/** Ledger/manifest reads are permitted only for a named evidence or audit need. */
	allowBoundedRecovery: boolean;
}

/**
 * Resolves one policy for both fresh launches and reuse turns. Invalid requests for full context
 * fail closed to the normal or remediation policy; full history is never an implicit role behavior.
 */
export function contextPolicyFor(input: {
	role?: string;
	workflowMode?: WorkflowMode;
	reviewMode?: ReviewMode;
	contextMode?: ContextMode;
	contextReason?: ContextReason;
}): ContextPolicy {
	const remediation = input.workflowMode === 'remediation' || input.reviewMode === 'remediation';
	const fallbackMode: ContextMode = remediation ? 'bounded-recovery' : 'compact';
	const fallbackReason: ContextReason = remediation ? 'remediation' : 'normal';
	const requestedReason = input.contextReason ?? fallbackReason;
	const fullReason = ['audit', 'integration', 'recovery'].includes(requestedReason);
	const requestedMode = input.contextMode;
	const mode =
		requestedMode === 'full' && !fullReason ? fallbackMode : (requestedMode ?? fallbackMode);
	const effectiveMode = mode === 'full' && fullReason ? 'full' : mode;
	return {
		mode: effectiveMode,
		reason: requestedMode === 'full' && !fullReason ? fallbackReason : requestedReason,
		preloadHistory: effectiveMode === 'full',
		allowBoundedRecovery: true,
	};
}

/**
 * How a ledger pointer reached a child: in the launch-time system prompt, in the task text of a
 * reuse turn, or not at all (no flow, or pointers disabled).
 */
export type LedgerInjection = 'prefix' | 'turn' | 'none';

/** What one turn wrote to the flow ledger, kept on the run summary and the telemetry record. */
export interface LedgerRunInfo {
	revision?: number;
	injection?: LedgerInjection;
	contextMode?: ContextMode;
	contextReason?: ContextReason;
}

export interface ReviewScope {
	paths?: string[];
	hunks?: string[];
	outOfScope?: string[];
}

export interface ReadManifest {
	v: 1;
	flowId?: string;
	manifestPath?: string;
	persistedPath?: string;
	artifactPaths: string[];
	allowedPaths: string[];
	/** Dirty repository paths captured with the review surface snapshot. */
	dirtyPaths?: string[];
	priorReports: string[];
	establishedEvidence: string[];
	doNotReread: string[];
	/** Structured refs minted or resolved by prior turns in this flow. Resolution hints, not verdicts: each must still be confirmed by a lookup. */
	knownRefs?: KnownManifestRef[];
}

/** Bounded outcome of the per-turn read-manifest handoff. */
export type ReadManifestStatus = 'available' | 'failed' | 'not_run';

/** Vocabulary of refs observed in a flow's predigest namespace. */
export type ManifestRefKind = 'verify' | 'read';

/** Producer lookup outcome classification carried by verify and read_batch lookup metadata. */
export type LookupOutcome = 'success' | 'not-found' | 'unauthorized-flow' | 'corrupt';

/** A flow ref the orchestrator observed a prior turn mint or resolve, with its verdict and freshness. */
export interface KnownManifestRef {
	ref: string;
	/** Ref vocabulary; absent means verify, matching records written before read refs existed. */
	kind?: ManifestRefKind;
	verdict?: 'passed' | 'failed' | 'incomplete';
	/** The observed run reused evidence for unchanged repository state instead of executing the gate. */
	reused: boolean;
	/** Freshness comparison made by the producer on lookup, when one ran. */
	repositoryStateStatus?: RepositoryStateStatus;
	/** First 12 chars of HEAD the evidence was minted against. */
	head?: string;
	/** First 12 chars of the dirty-state digest the evidence was minted against. */
	stateDigest?: string;
}

/** Orchestration context supplied by the delegating call. */
export interface OrchestrationContext {
	/** Stable task identity, preserved across remediation attempts of the same work. */
	taskId?: string;
	/** Session file of the root Pi session that owns this flow. */
	rootSession?: string;
	/** Pane that directly launched this delegation. */
	parentPaneId?: string;
	tier?: number;
	workflowMode?: WorkflowMode;
	reviewMode?: ReviewMode;
	acceptanceCriteria?: string[];
	/** Requested evidence scope; may only narrow the configured scope. */
	evidenceScope?: EvidenceScope;
	/** Effective standard-role composition policy for this delegation. */
	compositionPolicy?: CompositionPolicy;
	/** S4 boundary correlation for children of one real preflight. */
	compositionBoundaryId?: string;
	expectedChildCount?: number;
	/** Explicit per-call composition policy override, when supplied by the parent. */
	compositionPolicyOverride?: CompositionPolicy;
	/** Composition warnings that were checked before this child was spawned. */
	compositionVerdicts?: CompositionVerdict[];
	/** Files and hunks assigned to this delegation for focused review. */
	scope?: ReviewScope;
	/** Refreshed prompt context policy shared by fresh launches and reuse turns. */
	contextMode?: ContextMode;
	contextReason?: ContextReason;
	/** Flow-owned snapshot of the review surface. */
	reviewSurfacePath?: string;
	/** Monotonic revision of the flow-owned review surface snapshot. */
	reviewSurfaceRevision?: number;
	/** Whether this delegation caused the review surface to be rewritten. */
	reviewSurfaceRefreshed?: boolean;
	/** Git head recorded with the review surface snapshot, for comparison against published evidence. */
	reviewSurfaceHead?: string;
	/** Dirty paths captured while producing the review surface snapshot. */
	dirtyPaths?: string[];
}

/** Identity resolved for one delegation, exported into the child environment. */
export interface DelegationContext extends OrchestrationContext {
	delegationId: string;
	flowId?: string;
	role: string;
	evidenceScope: EvidenceScope;
}

/** Telemetry from one completed delegation turn, kept on the registry entry. */
export interface RunSummary {
	at: number;
	durationMs: number;
	toolCalls: number;
	nestedToolCalls?: number;
	failedToolCalls: number;
	repeatedReads: number;
	manifestRereads?: number;
	turns: number;
	cost: number;
	contextTokens: number;
	blockEvents?: number;
	approvalMs?: number;
	steerMs?: number;
	discoveryCalls?: number;
	fullValidationPasses?: number;
	outputTokens?: number;
	reportTokens?: number;
	report?: ReportSummary;
	/** Ledger revision written for this turn, and how the pointer reached the child. */
	ledgerRevision?: number;
	/** Prompt context policy used for this turn. */
	contextMode?: ContextMode;
	contextReason?: ContextReason;
	/** Validation refs minted or resolved during this turn. */
	validationRefs?: ValidationReference[];
	/** Failed validation-evidence lookups during this turn. */
	lookupFailures?: ValidationLookupFailure[];
	/** Execution-level producer fields observed during this turn. */
	validationExecutions?: ValidationExecution[];
	ledgerInjection?: LedgerInjection;
	scope?: ReviewScope;
	reviewSurfacePath?: string;
	reviewSurfaceRevision?: number;
	reviewSurfaceRefreshed?: boolean;
	reviewSurfaceHead?: string;
	dirtyPaths?: string[];
	readManifest?: ReadManifest;
	readManifestStatus?: ReadManifestStatus;
	budget?: BudgetSummary;
}

/** Measured size and provenance of a child report handed back to the parent. */
export interface ReportSummary {
	/** Prompt context policy used to produce this report. */
	contextMode?: ContextMode;
	contextReason?: ContextReason;
	/** Estimated tokens of the full child report. */
	tokens: number;
	/** Estimated tokens of the digest actually delivered to the parent. */
	digestTokens: number;
	truncated: boolean;
	ledgerParsed: boolean;
	/** Whether the report contained the mandatory reviewer inspection section. */
	filesReviewedPresent?: boolean;
	/** Paths named by the report's `## Files Reviewed` section. */
	filesReviewed?: string[];
	/** Report-contract violations detected while compressing the report. */
	contractIssues?: string[];
	/** Outcome of the read-manifest handoff for the reported turn. */
	readManifestStatus?: ReadManifestStatus;
	path?: string;
}

export interface RoleReport extends ReportSummary {
	digest: string;
}

export interface RegistryEntry {
	label: string;
	agent: string;
	workspace: string;
	workspaceName?: string;
	paneId: string;
	tabId: string;
	sessionFile: string;
	cwd: string;
	status: RegistryStatus;
	createdAt: number;
	updatedAt: number;
	/** Failure text from the last turn. Successful turns store no prose; see `lastRun.report.path`. */
	lastError?: string;
	contextTokens?: number;
	reuseCount?: number;
	tasks?: string[];
	parentSession?: string;
	blockedSince?: number;
	blockReason?: BlockReason;
	blockedPreview?: string;
	/** Stable across every turn of one delegation, including reuses. */
	delegationId?: string;
	/** Shared by every delegation spawned by one root session. */
	flowId?: string;
	/** Session file of the root Pi session that owns this entry. */
	rootSession?: string;
	/** Pane that directly launched this entry. */
	parentPaneId?: string;
	tier?: number;
	workflowMode?: WorkflowMode;
	reviewMode?: ReviewMode;
	acceptanceCriteria?: string[];
	taskId?: string;
	/** Refreshed context policy persisted with the session so reuse cannot inherit stale guidance. */
	contextMode?: ContextMode;
	contextReason?: ContextReason;
	evidenceScope?: EvidenceScope;
	scope?: ReviewScope;
	reviewSurfacePath?: string;
	reviewSurfaceRevision?: number;
	reviewSurfaceRefreshed?: boolean;
	reviewSurfaceHead?: string;
	dirtyPaths?: string[];
	readManifest?: ReadManifest;
	readManifestStatus?: ReadManifestStatus;
	/**
	 * Ledger revision this session was launched against. A reuse turn whose ledger head has advanced
	 * past it gets a fresh pointer in its task text, because the appended system prompt is frozen.
	 */
	ledgerRevisionAtLaunch?: number;
	lastRun?: RunSummary;
	budget?: BudgetSummary;
}

export interface FlowParticipant {
	label: string;
	agent: string;
	firstSeenAt: number;
}

export interface FlowManifest {
	v: 1;
	flowId: string;
	rootSession: string | null;
	createdAt: number;
	lastUsedAt: number;
	participants: FlowParticipant[];
	/**
	 * Highest ledger revision this extension has ever issued for the flow. Revision numbers continue
	 * from it, so a truncated or rewritten ledger cannot cause a revision to be reused.
	 */
	lastLedgerRevision?: number;
}

export interface Registry {
	counters: Record<string, Record<string, number>>;
	tabs: Record<string, RegistryEntry>;
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface ExecutionMetrics {
	durationMs: number;
	toolCalls: number;
	/** Calls recorded in the `nestedCalls` bounded record of tool results; transcript-derived. */
	nestedToolCalls: number;
	failedToolCalls: number;
	repeatedReads: number;
	manifestRereads?: number;
	/** read_batch evidence refs minted or confirmed during this turn, newest first, capped. */
	readRefs?: ReadReference[];
	/** Codegraph results that carried a producer index-state block, with distinct index ids. */
	codegraphIndex?: { results: number; indexIds: string[] };
	messageCount: number;
	taskChars: number;
	outputChars: number;
	maxContextTokens: number;
	turns: number;
	blockEvents: number;
	approvalMs: number;
	steerMs: number;
	discoveryCalls?: number;
	fullValidationPasses?: number;
	outputTokens?: number;
	/** Subset of `outputTokens` emitted on turns without tool calls; compared to the report budget. */
	reportOutputTokens?: number;
	/** Output emitted on turns that issued tool calls, bounded by the call budgets instead. */
	toolArgumentOutputTokens?: number;
	/** Reasoning/thinking tokens reported by the provider; excluded from the report budget. */
	reasoningTokens?: number;
	/**
	 * Tool-issued validation refs this child minted or resolved, in call order. Refs are resolvable inside
	 * the flow that minted them; the root session shares the flow id, so refs it mints resolve from children too.
	 */
	validationRefs?: ValidationReference[];
	/** Failed validation-evidence lookups, kept separate from successful zero-reuse runs. */
	lookupFailures?: ValidationLookupFailure[];
	/** Execution-level producer fields that are not attached to a reusable ref. */
	validationExecutions?: ValidationExecution[];
}

export type RepositoryStateStatus = 'matches' | 'mismatch' | 'unreadable';

export type ValidationLookupFailureClass = 'denied' | 'timeout' | 'not-found' | 'unknown';

export interface ValidationLookupFailure {
	/** Ref the lookup attempted, when the tool call named one. */
	ref?: string;
	errorClass: ValidationLookupFailureClass;
	message?: string;
	/** Structured producer lookup outcome classification, when the result carries it. */
	lookupOutcome?: LookupOutcome;
	/** Producer decision for the failed lookup, when emitted by the validation tool. */
	decision?: string;
	/** Producer cache decision for the failed lookup, when emitted by the validation tool. */
	cacheDecision?: string;
	/** Producer flow provenance; this is not inferred from producerScope. */
	flowId?: string;
	/** True when multiple distinct producer flow IDs made provenance ambiguous. */
	flowIdConflict?: boolean;
}

export interface ValidationExecution {
	tool: 'verify' | 'project_command';
	ref?: string;
	commandId?: string;
	stateDrift?: boolean;
	concurrentExecutions?: number;
	mutating?: boolean;
	forced?: boolean;
	/** Producer decision for the execution, when emitted by the validation tool. */
	decision?: string;
	/** Producer cache decision for the execution, when emitted by the validation tool. */
	cacheDecision?: string;
	/** Normalized publication outcome when the execution requested flow publication. */
	publication?: 'published' | 'unauthorized' | 'unavailable' | 'failed';
	/** Producer-provided publication failure reason, whitespace-flattened and bounded. */
	publicationReason?: string;
	/** Producer flow provenance; this is not inferred from producerScope. */
	flowId?: string;
	/** True when multiple distinct producer flow IDs made provenance ambiguous. */
	flowIdConflict?: boolean;
}

/** A read_batch evidence ref observed minted or confirmed during one turn. */
export interface ReadReference {
	ref: string;
	/** The item resolved existing evidence instead of minting a new ref. */
	reused: boolean;
	/** Set when this entry came from a read_batch ref lookup rather than a read result. */
	lookup?: boolean;
	/** Freshness comparison made by the producer on lookup. */
	repositoryStateStatus?: RepositoryStateStatus;
	/** Normalized publication outcome when the read requested flow publication. */
	publication?: 'published' | 'unauthorized' | 'unavailable' | 'failed';
	/** Producer-provided publication failure reason, whitespace-flattened and bounded. */
	publicationReason?: string;
	/** Producer flow provenance; this is not inferred from producerScope. */
	flowId?: string;
	/** True when multiple distinct producer flow IDs made provenance ambiguous. */
	flowIdConflict?: boolean;
}

export interface ValidationReference {
	/** Opaque ref issued by the validation tool. */
	ref: string;
	/** Aggregate verdict of the run the ref points at. */
	verdict?: 'passed' | 'failed' | 'incomplete';
	/** The run reused evidence for unchanged repository state instead of executing the gate. */
	reused: boolean;
	/** The call resolved this ref instead of running the gate. */
	lookup: boolean;
	/** First 12 chars of HEAD the evidence was minted against. */
	head?: string;
	/**
	 * First 12 chars of the dirty-state digest reported with the run. A ref carries the state it was
	 * minted against, so comparing refs inside one flow exposes evidence reused across differing states.
	 */
	stateDigest?: string;
	/** Freshness comparison made by the producer on lookup. */
	repositoryStateStatus?: RepositoryStateStatus;
	/** Structured producer lookup outcome classification, when the result carries it. */
	lookupOutcome?: LookupOutcome;
	/** True when the producer observed drift during an execution. */
	stateDrift?: boolean;
	/** Number of concurrent validation executions observed by the producer. */
	concurrentExecutions?: number;
	/** Whether the command was mutating. */
	mutating?: boolean;
	/** Whether the producer was forced to execute instead of reusing evidence. */
	forced?: boolean;
	/** Producer decision for this ref, when emitted by the validation tool. */
	decision?: string;
	/** Producer cache decision for this ref, when emitted by the validation tool. */
	cacheDecision?: string;
	/** Normalized publication outcome when the run requested flow publication. */
	publication?: 'published' | 'unauthorized' | 'unavailable' | 'failed';
	/** Producer-provided publication failure reason, whitespace-flattened and bounded. */
	publicationReason?: string;
	/** Producer flow provenance; this is not inferred from producerScope. */
	flowId?: string;
	/** True when multiple distinct producer flow IDs made provenance ambiguous. */
	flowIdConflict?: boolean;
	/** Validation phases reported as omitted rather than passed. */
	omitted?: string[];
	/** Whether this evidence was minted after the worker's final accepted implementation change. */
	finalState?: boolean;
}

export interface TelemetryRecord {
	v: 1;
	at: number;
	flowId?: string;
	delegationId: string;
	taskId?: string;
	workspace: string;
	label: string;
	agent: string;
	role: string;
	tier?: number;
	workflowMode?: WorkflowMode;
	reviewMode?: ReviewMode;
	acceptanceCriteria?: string[];
	evidenceScope: EvidenceScope;
	parentSession?: string;
	/** Explicit root session attribution; normally the same as parentSession. */
	rootSession?: string;
	compositionPolicy?: CompositionPolicy;
	compositionPolicyOverride?: CompositionPolicy;
	/** Legacy child-context alias; boundary events use the singular compositionVerdict field below. */
	compositionVerdicts?: CompositionVerdict[];
	/** Discriminates typed S4/composition events from ordinary child delegation records. */
	event?: 'composition' | 's4_preflight' | 's4_outcome';
	/** One composition decision checked at one subagent boundary. */
	compositionVerdict?: CompositionVerdict;
	/** Groups the per-rule event records emitted for one subagent boundary. */
	compositionBoundaryId?: string;
	/** Additive S4 preflight catalog coverage. */
	s4Preflight?: S4Preflight;
	/** Additive S4 correlated lifecycle/quality outcome. */
	s4Outcome?: S4Outcome;
	/** Action-specific status for typed composition boundary events; these are not child turns. */
	compositionBoundaryStatus?: 'warning' | 'refusal';
	/** Pane that directly launched this child. */
	parentPaneId?: string;
	childModel?: string;
	reused: boolean;
	reuseCount: number;
	outcome: 'settled' | 'failed' | 'aborted';
	exitCode: number;
	stopReason?: string;
	usage: UsageStats;
	metrics: ExecutionMetrics;
	sessionFile?: string;
	report?: ReportSummary;
	ledgerRevision?: number;
	ledgerInjection?: LedgerInjection;
	/** Prompt context policy recorded for audit and bounded recovery. */
	contextMode?: ContextMode;
	contextReason?: ContextReason;
	scope?: ReviewScope;
	reviewSurfacePath?: string;
	reviewSurfaceRevision?: number;
	reviewSurfaceRefreshed?: boolean;
	reviewSurfaceHead?: string;
	dirtyPaths?: string[];
	readManifest?: ReadManifest;
	readManifestStatus?: ReadManifestStatus;
	budget?: BudgetSummary;
}

export interface SingleResult {
	agent: string;
	agentSource: 'user' | 'project' | 'unknown' | 'reuse';
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	metrics?: ExecutionMetrics;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	herdrStatus?: HerdrStatus;
	paneId?: string;
	tabId?: string;
	label?: string;
	steered?: boolean;
	blockReason?: BlockReason;
	blockedSince?: number;
	blockedPreview?: string;
	/** Delegation this turn belongs to; stable across reuses of the same session. */
	delegationId?: string;
	scope?: ReviewScope;
	reviewSurfacePath?: string;
	reviewSurfaceRevision?: number;
	reviewSurfaceRefreshed?: boolean;
	reviewSurfaceHead?: string;
	dirtyPaths?: string[];
	readManifest?: ReadManifest;
	readManifestStatus?: ReadManifestStatus;
	flowId?: string;
	tier?: number;
	workflowMode?: WorkflowMode;
	reviewMode?: ReviewMode;
	taskId?: string;
	rootSession?: string;
	parentPaneId?: string;
	/** Accumulated user-interaction wait observed during this turn. */
	blockDurations?: { count: number; approvalMs: number; steerMs: number };
	/** Bounded report handed to the parent; full text persisted when a flow exists. */
	report?: RoleReport;
	/** Flow ledger revision written for this turn, and how its pointer reached the child. */
	ledgerRevision?: number;
	ledgerInjection?: LedgerInjection;
	/** Prompt context policy used for this turn. */
	contextMode?: ContextMode;
	contextReason?: ContextReason;
	budget?: BudgetSummary;
}

/**
 * Why a subagent call was refused before any child was launched.
 *
 * Refusal results keep their existing model-facing text but are marked `isError: true`, so a model
 * and a programmatic caller both see them as failures instead of empty successes. The kind and the
 * text are also carried in the bounded structured projection for codemode callers.
 */
export type SubagentRefusalKind =
	| 'invalid-params'
	| 'nested'
	| 'session-unavailable'
	| 'spawn-boundary'
	| 'overlapping-scope'
	| 'too-many-tasks'
	| 'composition'
	| 'project-agents-denied'
	| 'reuse-without-task';

export interface SubagentRefusal {
	kind: SubagentRefusalKind;
	/** Model-facing refusal text; the structured projection caps it. */
	message: string;
}

export interface SubagentDetails {
	mode: 'single' | 'parallel' | 'chain';
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	/** Set when the call was refused before any child ran; absent on normal results. */
	refusal?: SubagentRefusal;
}

export type DisplayItem =
	| { type: 'text'; text: string }
	| { type: 'toolCall'; name: string; args: Record<string, any> };

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export const ABORT_ERROR = new Error('Subagent was aborted');

export function makeEmptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}
