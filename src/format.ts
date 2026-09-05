import * as os from 'node:os';
import type { Message } from '@earendil-works/pi-ai';
import { getConfig } from './config.ts';
import type {
	DisplayItem,
	ExecutionMetrics,
	LedgerRunInfo,
	RegistryEntry,
	ReportSummary,
	RunSummary,
	SingleResult,
} from './types.ts';

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatExecutionMetrics(metrics: ExecutionMetrics): string {
	const duration =
		metrics.durationMs < 1000
			? `${metrics.durationMs}ms`
			: `${(metrics.durationMs / 1000).toFixed(1)}s`;
	const parts = [
		`time:${duration}`,
		`tools:${metrics.toolCalls}`,
		`msgs:${metrics.messageCount}`,
		`io:${metrics.taskChars}/${metrics.outputChars}`,
	];
	if (metrics.failedToolCalls) parts.push(`tool-errors:${metrics.failedToolCalls}`);
	if (metrics.repeatedReads) parts.push(`rereads:${metrics.repeatedReads}`);
	if (metrics.manifestRereads) parts.push(`manifest-rereads:${metrics.manifestRereads}`);
	if (metrics.discoveryCalls !== undefined) parts.push(`discovery:${metrics.discoveryCalls}`);
	if (metrics.fullValidationPasses !== undefined)
		parts.push(`validation:${metrics.fullValidationPasses}`);
	if (metrics.validationRefs?.length) {
		const executed = metrics.validationRefs.filter((reference) => !reference.lookup).length;
		parts.push(`verify:${metrics.validationRefs.length} ran:${executed}`);
	}
	if (metrics.outputTokens !== undefined)
		parts.push(`output:${formatTokens(metrics.outputTokens)}`);
	if (metrics.maxContextTokens) parts.push(`max-ctx:${formatTokens(metrics.maxContextTokens)}`);
	return parts.join(' ');
}

export function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? 's' : ''}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(' ');
}

type ThemeFg = (color: any, text: string) => string;

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function bashPreview(args: Record<string, unknown>, themeFg: ThemeFg): string {
	const command = (args.command as string) || '...';
	const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
	return themeFg('muted', '$ ') + themeFg('toolOutput', preview);
}

function readPreview(args: Record<string, unknown>, themeFg: ThemeFg): string {
	const rawPath = (args.file_path || args.path || '...') as string;
	const filePath = shortenPath(rawPath);
	const offset = args.offset as number | undefined;
	const limit = args.limit as number | undefined;
	let text = themeFg('accent', filePath);
	if (offset !== undefined || limit !== undefined) {
		const startLine = offset ?? 1;
		const endLine = limit !== undefined ? startLine + limit - 1 : '';
		text += themeFg('warning', `:${startLine}${endLine ? `-${endLine}` : ''}`);
	}
	return themeFg('muted', 'read ') + text;
}

function writePreview(args: Record<string, unknown>, themeFg: ThemeFg): string {
	const rawPath = (args.file_path || args.path || '...') as string;
	const filePath = shortenPath(rawPath);
	const content = (args.content || '') as string;
	const lines = content.split('\n').length;
	let text = themeFg('muted', 'write ') + themeFg('accent', filePath);
	if (lines > 1) text += themeFg('dim', ` (${lines} lines)`);
	return text;
}

function editPreview(args: Record<string, unknown>, themeFg: ThemeFg): string {
	const rawPath = (args.file_path || args.path || '...') as string;
	return themeFg('muted', 'edit ') + themeFg('accent', shortenPath(rawPath));
}

function lsPreview(args: Record<string, unknown>, themeFg: ThemeFg): string {
	const rawPath = (args.path || '.') as string;
	return themeFg('muted', 'ls ') + themeFg('accent', shortenPath(rawPath));
}

function findPreview(args: Record<string, unknown>, themeFg: ThemeFg): string {
	const pattern = (args.pattern || '*') as string;
	const rawPath = (args.path || '.') as string;
	return (
		themeFg('muted', 'find ') +
		themeFg('accent', pattern) +
		themeFg('dim', ` in ${shortenPath(rawPath)}`)
	);
}

function grepPreview(args: Record<string, unknown>, themeFg: ThemeFg): string {
	const pattern = (args.pattern || '') as string;
	const rawPath = (args.path || '.') as string;
	return (
		themeFg('muted', 'grep ') +
		themeFg('accent', `/${pattern}/`) +
		themeFg('dim', ` in ${shortenPath(rawPath)}`)
	);
}

function defaultPreview(toolName: string, args: Record<string, unknown>, themeFg: ThemeFg): string {
	const argsStr = JSON.stringify(args);
	const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
	return themeFg('accent', toolName) + themeFg('dim', ` ${preview}`);
}

export function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	switch (toolName) {
		case 'bash':
			return bashPreview(args, themeFg);
		case 'read':
			return readPreview(args, themeFg);
		case 'write':
			return writePreview(args, themeFg);
		case 'edit':
			return editPreview(args, themeFg);
		case 'ls':
			return lsPreview(args, themeFg);
		case 'find':
			return findPreview(args, themeFg);
		case 'grep':
			return grepPreview(args, themeFg);
		default:
			return defaultPreview(toolName, args, themeFg);
	}
}

function formatClockTime(ts: number): string {
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function formatBlockedPreview(name: string, args: Record<string, any>): string {
	const argPath =
		typeof args.path === 'string'
			? args.path
			: typeof args.file_path === 'string'
				? args.file_path
				: undefined;
	let preview = argPath ? `${name} ${argPath}` : name;
	if (typeof args.command === 'string') {
		const cmd = args.command.replace(/\s+/g, ' ').trim();
		preview = name === 'bash' ? `bash ${cmd}` : `${name} ${cmd}`;
	}
	return preview.length > 90 ? `${preview.slice(0, 87)}...` : preview;
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === 'assistant') {
			for (const part of msg.content) {
				if (part.type === 'text') return part.text;
			}
		}
	}
	return '';
}

export function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === 'error' || result.stopReason === 'aborted';
}

export function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || '(no output)';
	}
	return getFinalOutput(result.messages) || '(no output)';
}

export function findPendingToolCall(
	messages: Message[],
	pendingToolCalls: Map<string, { name: string; args: Record<string, any> }>,
): { name: string; args: Record<string, any> } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== 'assistant') continue;
		for (const part of msg.content) {
			if (part.type === 'toolCall' && pendingToolCalls.has(part.id)) {
				return { name: part.name, args: part.arguments };
			}
		}
	}
	return undefined;
}

export function blockedSummaryLine(r: SingleResult): string {
	const reason =
		r.blockReason === 'approval'
			? `awaiting approval${r.blockedPreview ? `: ${r.blockedPreview}` : ''}`
			: 'needs input';
	const since = r.blockedSince ? `, since ${formatClockTime(r.blockedSince)}` : '';
	const tab = r.label ? `tab ${r.paneId?.split(':')[0] ?? ''}:${r.label}` : 'its tab';
	const action = r.blockReason === 'approval' ? 'approve/reject' : 'steer';
	return `blocked - ${reason}${since} (${action} in ${tab})`;
}

export function statusTag(r: SingleResult): string {
	if (r.herdrStatus === 'blocked') {
		return r.blockReason === 'approval'
			? r.blockedPreview
				? `blocked - awaiting approval: ${r.blockedPreview}`
				: 'blocked - awaiting approval'
			: 'blocked - needs input';
	}
	if (r.herdrStatus === 'idle' || r.herdrStatus === 'done') return 'settling';
	if (r.herdrStatus === 'working') return 'working';
	return 'starting';
}

export function registryBlockedInfo(e: RegistryEntry): string | null {
	if (e.status !== 'running' || !e.blockedSince) return null;
	const since = formatClockTime(e.blockedSince);
	const reason =
		e.blockReason === 'approval'
			? `awaiting approval${e.blockedPreview ? `: ${e.blockedPreview}` : ''}`
			: 'needs input';
	return `blocked since ${since} (${reason})`;
}

/** Error text the registry keeps, so a child that died before its first message stays diagnosable. */
const LAST_ERROR_STORED_CHARS = 500;

export function completionPatch(currentResult: SingleResult): Partial<RegistryEntry> {
	const patch: Partial<RegistryEntry> = {
		status: 'done',
		lastError: undefined,
		updatedAt: Date.now(),
		blockedSince: undefined,
		blockReason: undefined,
		blockedPreview: undefined,
		...(currentResult.budget ? { budget: currentResult.budget } : {}),
		...(currentResult.scope ? { scope: currentResult.scope } : {}),
		...(currentResult.reviewSurfacePath
			? { reviewSurfacePath: currentResult.reviewSurfacePath }
			: {}),
		...(currentResult.readManifest ? { readManifest: currentResult.readManifest } : {}),
	};
	if (isFailedResult(currentResult)) {
		const error = getResultOutput(currentResult).replace(/\s+/g, ' ').trim();
		patch.lastError =
			error.length > LAST_ERROR_STORED_CHARS
				? `${error.slice(0, LAST_ERROR_STORED_CHARS)}...`
				: error;
	}
	if (currentResult.usage.contextTokens > 0) {
		patch.contextTokens = currentResult.usage.contextTokens;
	}
	return patch;
}

/** Compact spend summary kept on the registry entry for reuse decisions. */
export function buildRunSummary(
	metrics: ExecutionMetrics,
	usage: SingleResult['usage'],
	report?: ReportSummary,
	ledger?: LedgerRunInfo,
	now = Date.now(),
	budget?: SingleResult['budget'],
): RunSummary {
	const summary: RunSummary = {
		at: now,
		durationMs: metrics.durationMs,
		toolCalls: metrics.toolCalls,
		failedToolCalls: metrics.failedToolCalls,
		repeatedReads: metrics.repeatedReads,
		turns: usage.turns || metrics.turns,
		cost: usage.cost,
		contextTokens: usage.contextTokens || metrics.maxContextTokens,
	};
	if (metrics.blockEvents) summary.blockEvents = metrics.blockEvents;
	if (metrics.discoveryCalls !== undefined) summary.discoveryCalls = metrics.discoveryCalls;
	if (metrics.fullValidationPasses !== undefined)
		summary.fullValidationPasses = metrics.fullValidationPasses;
	if (metrics.outputTokens !== undefined) summary.outputTokens = metrics.outputTokens;
	if (metrics.manifestRereads) summary.manifestRereads = metrics.manifestRereads;
	if (metrics.approvalMs) summary.approvalMs = metrics.approvalMs;
	if (metrics.steerMs) summary.steerMs = metrics.steerMs;
	if (ledger?.revision !== undefined) summary.ledgerRevision = ledger.revision;
	if (ledger?.injection && ledger.injection !== 'none') summary.ledgerInjection = ledger.injection;
	if (budget) summary.budget = budget;
	if (report) {
		summary.reportTokens = report.tokens;
		// The registry is read on every delegation: keep counts and provenance, never the text.
		summary.report = {
			tokens: report.tokens,
			digestTokens: report.digestTokens,
			truncated: report.truncated,
			ledgerParsed: report.ledgerParsed,
		};
		if (report.path) summary.report.path = report.path;
	}
	return summary;
}
export function applyOutputByteCap(output: string): string {
	const cap = getConfig().perTaskOutputCap;
	const byteLength = Buffer.byteLength(output, 'utf8');
	if (byteLength <= cap) return output;

	let truncated = output.slice(0, cap);
	while (Buffer.byteLength(truncated, 'utf8') > cap) {
		truncated = truncated.slice(0, -1);
	}
	const omitted = byteLength - Buffer.byteLength(truncated, 'utf8');
	return `${truncated}\n\n[Output truncated: ${omitted} bytes omitted beyond the byte cap. Full text remains in the role report and tool details.]`;
}

export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === 'assistant') {
			for (const part of msg.content) {
				if (part.type === 'text') items.push({ type: 'text', text: part.text });
				else if (part.type === 'toolCall')
					items.push({ type: 'toolCall', name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}
