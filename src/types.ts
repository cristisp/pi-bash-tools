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
