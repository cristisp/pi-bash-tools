import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { formatTokens } from './format.ts';
import { findEntry } from './registry.ts';
import type { RegistryEntry } from './types.ts';

const HIGH_CONTEXT_THRESHOLD = 100_000;
const HIGH_TURNS_THRESHOLD = 8;
const MAX_TASK_HISTORY = 5;
const MAX_TASK_PREVIEWS = 3;
const TASK_PREVIEW_LENGTH = 80;
const LAST_ERROR_PREVIEW_LENGTH = 300;

interface ParsedSession {
	turns: number;
	input: number;
	output: number;
	cost: number;
	contextTokens: number;
	userTasks: string[];
}

function newParsedSession(): ParsedSession {
	return {
		turns: 0,
		input: 0,
		output: 0,
		cost: 0,
		contextTokens: 0,
		userTasks: [],
	};
}

function parseSessionLine(line: string): any | null {
	if (!line.trim()) return null;
	try {
		const entry = JSON.parse(line);
		if (entry?.type === 'message' && entry?.message) return entry.message;
	} catch {}
	return null;
}

function accumulateUsage(parsed: ParsedSession, usage: any): void {
	parsed.input += usage.input ?? 0;
	parsed.output += usage.output ?? 0;
	parsed.cost += usage.cost?.total ?? 0;
	if (usage.totalTokens) parsed.contextTokens = usage.totalTokens;
}

function userMessageText(msg: any): string {
	if (!Array.isArray(msg.content)) return '';
	return msg.content
		.filter((part: any) => part?.type === 'text')
		.map((part: any) => part.text ?? '')
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function accumulateMessage(parsed: ParsedSession, msg: any): void {
	if (msg.role === 'assistant') {
		parsed.turns++;
		if (msg.usage) accumulateUsage(parsed, msg.usage);
		return;
	}
	if (msg.role === 'user') {
		const text = userMessageText(msg);
		if (text) {
			parsed.userTasks.push(text);
			if (parsed.userTasks.length > MAX_TASK_HISTORY) parsed.userTasks.shift();
		}
	}
}

async function parseSessionFile(sessionFile: string): Promise<ParsedSession> {
	const parsed = newParsedSession();
	let stream: fs.ReadStream | null = null;
	try {
		stream = fs.createReadStream(sessionFile, { encoding: 'utf8' });
		const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
		for await (const line of rl) {
			const msg = parseSessionLine(line);
			if (msg) accumulateMessage(parsed, msg);
		}
	} catch {
		return parsed;
	} finally {
		stream?.destroy();
	}
	return parsed;
}

function taskLines(tasks: string[] | undefined, fallback: string[]): string {
	const source = tasks && tasks.length > 0 ? tasks : fallback;
	const list = source.slice(-MAX_TASK_PREVIEWS);
	if (list.length === 0) return '  (none)';
	return list
		.map((t, i) => {
			const oneLine = t.replace(/\s+/g, ' ').trim();
			const preview =
				oneLine.length > TASK_PREVIEW_LENGTH
					? `${oneLine.slice(0, TASK_PREVIEW_LENGTH)}...`
					: oneLine;
			return `  ${i + 1}. ${preview}`;
		})
		.join('\n');
}

function contextLine(entry: RegistryEntry, parsed: ParsedSession): string {
	const liveCtx = parsed.contextTokens > 0 ? formatTokens(parsed.contextTokens) : null;
	const regCtx =
		entry.contextTokens && entry.contextTokens > 0 ? formatTokens(entry.contextTokens) : null;
	const ctx = liveCtx ?? regCtx ?? 'unknown';
	const suffix = liveCtx && regCtx && liveCtx !== regCtx ? ` (registry: ${regCtx})` : '';
	return `  context: ${ctx} tokens (last turn)${suffix}`;
}

function usageLine(parsed: ParsedSession): string | null {
	const parts: string[] = [];
	if (parsed.input) parts.push(`↑${formatTokens(parsed.input)}`);
	if (parsed.output) parts.push(`↓${formatTokens(parsed.output)}`);
	if (parsed.cost) parts.push(`$${parsed.cost.toFixed(4)}`);
	return parts.length > 0 ? `usage: ${parts.join(' ')}` : null;
}

/** What the last turn left behind: its error, or where its full report lives. */
function lastLine(entry: RegistryEntry): string | null {
	if (entry.lastError) {
		const one = entry.lastError.replace(/\s+/g, ' ').trim();
		const preview =
			one.length > LAST_ERROR_PREVIEW_LENGTH
				? `${one.slice(0, LAST_ERROR_PREVIEW_LENGTH)}...`
				: one;
		return `last error: ${preview}`;
	}
	const path = entry.lastRun?.report?.path;
	return path ? `last report: ${path}` : null;
}

function reuseHints(entry: RegistryEntry | undefined, parsed: ParsedSession): string[] {
	const hints: string[] = [];
	if (parsed.contextTokens > HIGH_CONTEXT_THRESHOLD) {
		hints.push(
			`Context is large (${formatTokens(parsed.contextTokens)}); prefer a fresh session for substantial new work.`,
		);
	}
	if (parsed.turns > HIGH_TURNS_THRESHOLD) {
		const taskCount = entry?.tasks?.length || parsed.userTasks.length;
		hints.push(
			`${parsed.turns} turns across ${taskCount} task(s); context and cost keep accumulating.`,
		);
	}
	if (entry?.reuseCount && entry.reuseCount > 0) {
		hints.push(`Reused ${entry.reuseCount} time(s); verify task continuity before reusing again.`);
	}
	if (entry?.lastRun?.manifestRereads) {
		hints.push(
			`Re-read ${entry.lastRun.manifestRereads} manifest-protected path(s); inspect the evidence gap before reusing.`,
		);
	}
	return hints;
}

function identityLine(entry: RegistryEntry): string {
	const parts: string[] = [];
	if (entry.delegationId) parts.push(`delegation: ${entry.delegationId}`);
	if (entry.flowId) parts.push(`flow: ${entry.flowId}`);
	if (entry.rootSession) parts.push(`root: ${entry.rootSession}`);
	if (entry.parentPaneId) parts.push(`parent pane: ${entry.parentPaneId}`);
	if (typeof entry.tier === 'number') parts.push(`tier: ${entry.tier}`);
	if (entry.workflowMode) parts.push(`mode: ${entry.workflowMode}`);
	if (entry.reviewMode) parts.push(`review: ${entry.reviewMode}`);
	if (entry.acceptanceCriteria?.length)
		parts.push(`criteria: ${entry.acceptanceCriteria.join(',')}`);
	if (entry.scope?.paths?.length) parts.push(`scope: ${entry.scope.paths.join(',')}`);
	if (entry.scope?.hunks?.length) parts.push(`hunks: ${entry.scope.hunks.join(',')}`);
	if (entry.scope?.outOfScope?.length)
		parts.push(`out of scope: ${entry.scope.outOfScope.join(',')}`);
	if (entry.reviewSurfacePath) parts.push(`surface: ${entry.reviewSurfacePath}`);
	const manifestPath =
		entry.readManifest?.persistedPath ??
		entry.readManifest?.manifestPath ??
		entry.lastRun?.readManifest?.persistedPath ??
		entry.lastRun?.readManifest?.manifestPath;
	if (manifestPath) parts.push(`manifest: ${manifestPath}`);
	if (entry.budget) parts.push(`budget: ${entry.budget.outcome}/${entry.budget.breaches.length}`);
	parts.push(`evidence: ${entry.evidenceScope ?? 'unknown'}`);
	return parts.join('  ');
}

function lastRunLine(entry: RegistryEntry): string | null {
	const run = entry.lastRun;
	if (!run) return null;
	const parts = [`tools:${run.toolCalls}`];
	if (run.nestedToolCalls) parts.push(`nested:${run.nestedToolCalls}`);
	if (run.failedToolCalls) parts.push(`tool-errors:${run.failedToolCalls}`);
	if (run.repeatedReads) parts.push(`rereads:${run.repeatedReads}`);
	if (run.manifestRereads) parts.push(`manifest-rereads:${run.manifestRereads}`);
	if (run.discoveryCalls !== undefined) parts.push(`discovery:${run.discoveryCalls}`);
	if (run.fullValidationPasses !== undefined) parts.push(`validation:${run.fullValidationPasses}`);
	if (run.validationRefs?.length || run.lookupFailures?.length) {
		const executed = run.validationRefs?.filter((reference) => !reference.lookup).length ?? 0;
		const failed = run.lookupFailures?.length ?? 0;
		parts.push(`verify:${(run.validationRefs?.length ?? 0) + failed} ran:${executed}`);
		if (failed) parts.push(`unresolved:${failed}`);
	}
	if (run.outputTokens !== undefined) parts.push(`output:${formatTokens(run.outputTokens)}`);
	if (run.budget) parts.push(`budget:${run.budget.outcome}/${run.budget.breaches.length}`);
	if (run.turns) parts.push(`turns:${run.turns}`);
	if (run.cost) parts.push(`$${run.cost.toFixed(4)}`);
	if (run.contextTokens) parts.push(`ctx:${formatTokens(run.contextTokens)}`);
	const waiting = (run.approvalMs ?? 0) + (run.steerMs ?? 0);
	if (waiting) parts.push(`waiting:${(waiting / 1000).toFixed(1)}s`);
	if (run.report) {
		const ledger = run.report.ledgerParsed ? '' : ':no-ledger';
		const review = run.report.filesReviewedPresent === false ? ':no-files-reviewed' : '';
		parts.push(`report:${run.report.digestTokens}/${run.report.tokens}${ledger}${review}`);
	}
	if (run.ledgerRevision !== undefined) {
		parts.push(
			`ledger:r${run.ledgerRevision}${run.ledgerInjection ? `/${run.ledgerInjection}` : ''}`,
		);
	}
	return `last run: ${parts.join(' ')}`;
}

export async function sessionStatsText(label: string, parentSession?: string): Promise<string> {
	const entry = findEntry(label, parentSession);
	if (!entry) {
		return `No subagent session labeled "${label}" in the active Pi session. Use listSubagents and pass the bare label shown after "reuseLabel:".`;
	}
	const parsed = await parseSessionFile(entry.sessionFile);
	const lines: string[] = [
		`Session ${entry.workspace}:${entry.label} (${entry.agent}, ${entry.status})`,
		contextLine(entry, parsed).replace(/^  /, ''),
		`turns: ${parsed.turns}  reused: ${entry.reuseCount ?? 0}`,
		identityLine(entry),
	];
	const lastRun = lastRunLine(entry);
	if (lastRun) lines.push(lastRun);
	const usage = usageLine(parsed);
	if (usage) lines.push(usage);
	lines.push('recent tasks:');
	lines.push(taskLines(entry.tasks, parsed.userTasks));
	const last = lastLine(entry);
	if (last) lines.push(last);
	const hints = reuseHints(entry, parsed);
	if (hints.length > 0) {
		lines.push('notes:');
		for (const hint of hints) lines.push(`- ${hint}`);
	}
	return lines.join('\n');
}
