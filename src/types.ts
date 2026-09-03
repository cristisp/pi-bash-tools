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

export type EvidenceScope = 'session' | 'flow';

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

/** Orchestration context supplied by the delegating call. */
export interface OrchestrationContext {
	/** Stable task identity, preserved across remediation attempts of the same work. */
	taskId?: string;
	tier?: number;
	workflowMode?: WorkflowMode;
	reviewMode?: ReviewMode;
	acceptanceCriteria?: string[];
	/** Requested evidence scope; may only narrow the configured scope. */
	evidenceScope?: EvidenceScope;
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
	turns: number;
	cost: number;
	contextTokens: number;
	blockEvents?: number;
	approvalMs?: number;
	steerMs?: number;
	reportTokens?: number;
	report?: ReportSummary;
	/** Ledger revision written for this turn, and how the pointer reached the child. */
	ledgerRevision?: number;
	ledgerInjection?: LedgerInjection;
}

/** Measured size and provenance of a child report handed back to the parent. */
export interface ReportSummary {
	/** Estimated tokens of the full child report. */
	tokens: number;
	/** Estimated tokens of the digest actually delivered to the parent. */
	digestTokens: number;
	truncated: boolean;
	ledgerParsed: boolean;
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
	tier?: number;
	workflowMode?: WorkflowMode;
	reviewMode?: ReviewMode;
	acceptanceCriteria?: string[];
	taskId?: string;
	evidenceScope?: EvidenceScope;
	/**
	 * Ledger revision this session was launched against. A reuse turn whose ledger head has advanced
	 * past it gets a fresh pointer in its task text, because the appended system prompt is frozen.
	 */
	ledgerRevisionAtLaunch?: number;
	lastRun?: RunSummary;
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
	messageCount: number;
	taskChars: number;
	outputChars: number;
	maxContextTokens: number;
	turns: number;
	blockEvents: number;
	approvalMs: number;
	steerMs: number;
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
	flowId?: string;
	/** Accumulated user-interaction wait observed during this turn. */
	blockDurations?: { count: number; approvalMs: number; steerMs: number };
	/** Bounded report handed to the parent; full text persisted when a flow exists. */
	report?: RoleReport;
	/** Flow ledger revision written for this turn, and how its pointer reached the child. */
	ledgerRevision?: number;
	ledgerInjection?: LedgerInjection;
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
