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

export interface RoleBudget {
	toolCalls: number;
	discoveryCalls: number;
	/** Worker-only discovery allowance before the first implementation tool call. */
	implementationDiscoveryCalls?: number;
	fullValidationPasses: number;
	failedToolCalls: number;
	repeatedReads: number;
	outputTokens: number;
	wallTimeMs: number;
	budgetPolicy: BudgetPolicy;
}

export interface BudgetUsage {
	toolCalls: number;
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
}

export type EvidenceScope = 'session' | 'flow';

/** How standard-role composition violations are handled before children are spawned. */
export type CompositionPolicy = 'warn' | 'enforce' | 'off';

export type CompositionRuleId = 'R1' | 'R2' | 'R3' | 'R4';
export type CompositionMode = 'single' | 'parallel' | 'chain';
export type CompositionAction = 'warn' | 'refuse';
export type CompositionVerdictKind = 'warning' | 'refusal';

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
	return `Composition policy (default warn; per-call override warn|enforce|off): enforce refuses violations, warn reports them and still spawns, and off disables these standard-role checks.\n${compositionRulesText()}`;
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

/**
 * How a ledger pointer reached a child: in the launch-time system prompt, in the task text of a
 * reuse turn, or not at all (no flow, or pointers disabled).
 */
export type LedgerInjection = 'prefix' | 'turn' | 'none';

/** What one turn wrote to the flow ledger, kept on the run summary and the telemetry record. */
export interface LedgerRunInfo {
	revision?: number;
	injection?: LedgerInjection;
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
	/** Explicit per-call composition policy override, when supplied by the parent. */
	compositionPolicyOverride?: CompositionPolicy;
	/** Composition warnings that were checked before this child was spawned. */
	compositionVerdicts?: CompositionVerdict[];
	/** Files and hunks assigned to this delegation for focused review. */
	scope?: ReviewScope;
	/** Flow-owned snapshot of the review surface. */
	reviewSurfacePath?: string;
	/** Monotonic revision of the flow-owned review surface snapshot. */
	reviewSurfaceRevision?: number;
	/** Whether this delegation caused the review surface to be rewritten. */
	reviewSurfaceRefreshed?: boolean;
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
	dirtyPaths?: string[];
	readManifest?: ReadManifest;
	budget?: BudgetSummary;
}

/** Measured size and provenance of a child report handed back to the parent. */
export interface ReportSummary {
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
	evidenceScope?: EvidenceScope;
	scope?: ReviewScope;
	reviewSurfacePath?: string;
	reviewSurfaceRevision?: number;
	reviewSurfaceRefreshed?: boolean;
	dirtyPaths?: string[];
	readManifest?: ReadManifest;
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
	failedToolCalls: number;
	repeatedReads: number;
	manifestRereads?: number;
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
	 * the flow that minted them; refs minted by a root session are process-local and never reach a child.
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
}

export interface ValidationExecution {
	tool: 'verify' | 'project_command';
	ref?: string;
	commandId?: string;
	stateDrift?: boolean;
	concurrentExecutions?: number;
	mutating?: boolean;
	forced?: boolean;
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
	/** True when the producer observed drift during an execution. */
	stateDrift?: boolean;
	/** Number of concurrent validation executions observed by the producer. */
	concurrentExecutions?: number;
	/** Whether the command was mutating. */
	mutating?: boolean;
	/** Whether the producer was forced to execute instead of reusing evidence. */
	forced?: boolean;
	/** Validation phases reported as omitted rather than passed. */
	omitted?: string[];
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
	/** Discriminates a typed composition event from an ordinary child delegation record. */
	event?: 'composition';
	/** One composition decision checked at one subagent boundary. */
	compositionVerdict?: CompositionVerdict;
	/** Groups the per-rule event records emitted for one subagent boundary. */
	compositionBoundaryId?: string;
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
	scope?: ReviewScope;
	reviewSurfacePath?: string;
	reviewSurfaceRevision?: number;
	reviewSurfaceRefreshed?: boolean;
	dirtyPaths?: string[];
	readManifest?: ReadManifest;
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
	dirtyPaths?: string[];
	readManifest?: ReadManifest;
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
	budget?: BudgetSummary;
}

export interface SubagentDetails {
	mode: 'single' | 'parallel' | 'chain';
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

export type DisplayItem =
	| { type: 'text'; text: string }
	| { type: 'toolCall'; name: string; args: Record<string, any> };

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export const ABORT_ERROR = new Error('Subagent was aborted');

export function makeEmptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}
