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

/** Orchestration context supplied by the delegating call. */
export interface OrchestrationContext {
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
	lastResult: string;
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
	evidenceScope?: EvidenceScope;
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
