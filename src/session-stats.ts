import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { formatTokens } from './format.ts';
import { findEntry } from './registry.ts';
import type { RegistryEntry } from './types.ts';

const HIGH_CONTEXT_THRESHOLD = 100_000;
const HIGH_TURNS_THRESHOLD = 8;

interface ParsedSession {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	userTasks: string[];
}

function newParsedSession(): ParsedSession {
	return {
		turns: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
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
	parsed.cacheRead += usage.cacheRead ?? 0;
	parsed.cacheWrite += usage.cacheWrite ?? 0;
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
		if (text) parsed.userTasks.push(text);
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

function formatAge(ts: number | undefined): string {
	if (!ts) return 'unknown';
	const mins = Math.max(0, Math.round((Date.now() - ts) / 60_000));
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins} min ago`;
	const hours = Math.round(mins / 60);
	if (hours < 48) return `${hours} h ago`;
	return `${Math.round(hours / 24)} d ago`;
}

function taskLines(tasks: string[] | undefined, fallback: string[]): string {
	const list = tasks && tasks.length > 0 ? tasks : fallback.slice(-5);
	if (list.length === 0) return '  (no task history yet)';
	return list
		.map((t, i) => {
			const oneLine = t.replace(/\s+/g, ' ').trim();
			const preview = oneLine.length > 100 ? `${oneLine.slice(0, 100)}...` : oneLine;
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
	if (parsed.cacheRead) parts.push(`R${formatTokens(parsed.cacheRead)}`);
	if (parsed.cacheWrite) parts.push(`W${formatTokens(parsed.cacheWrite)}`);
	if (parsed.cost) parts.push(`$${parsed.cost.toFixed(4)}`);
	return parts.length > 0 ? `  lifetime usage: ${parts.join(' ')}` : null;
}

function lastResultLine(entry: RegistryEntry): string | null {
	if (!entry.lastResult) return null;
	const last = entry.lastResult.replace(/\s+/g, ' ').trim();
	const preview = last.length > 200 ? `${last.slice(0, 200)}...` : last;
	return `  last result: ${preview}`;
}

function reuseHints(entry: RegistryEntry | undefined, parsed: ParsedSession): string[] {
	const hints: string[] = [];
	if (parsed.contextTokens > HIGH_CONTEXT_THRESHOLD) {
		hints.push(
			`Context is large (${formatTokens(parsed.contextTokens)} tokens) - continuing this session may hit the model limit or degrade quality; prefer a fresh session for substantial new work.`,
		);
	}
	if (parsed.turns > HIGH_TURNS_THRESHOLD) {
		hints.push(
			`This session has already done ${parsed.turns} turns across ${entry?.tasks?.length ?? 1} task(s) - reuse keeps accumulating context and cost; weigh that against the cost of re-establishing context in a fresh session.`,
		);
	}
	if (entry?.reuseCount && entry.reuseCount > 0) {
		hints.push(
			`This session has been reused ${entry.reuseCount} time(s) - check the task history below for topical fit. Reusing a review/audit/verification session anchors it on its earlier findings: for a fresh review of code that changed since, start a new session or explicitly instruct it to re-examine from scratch.`,
		);
	}
	return hints;
}

export async function sessionStatsText(label: string): Promise<string> {
	const entry = findEntry(label);
	if (!entry) {
		return `No subagent session labeled "${label}". Use listSubagents to see available sessions.`;
	}
	const parsed = await parseSessionFile(entry.sessionFile);
	const fileSize = (() => {
		try {
			return fs.statSync(entry.sessionFile).size;
		} catch {
			return 0;
		}
	})();

	const lines: string[] = [
		`Session ${entry.workspace}:${entry.label} (agent: ${entry.agent}, status: ${entry.status})`,
		contextLine(entry, parsed),
		`  turns: ${parsed.turns}  session file: ${formatTokens(fileSize)}B  age: ${formatAge(entry.updatedAt)}`,
	];
	const usage = usageLine(parsed);
	if (usage) lines.push(usage);
	if (entry.reuseCount && entry.reuseCount > 0) {
		lines.push(`  reused: ${entry.reuseCount} time(s)`);
	}
	const hints = reuseHints(entry, parsed);
	if (hints.length > 0) {
		lines.push('  notes:');
		for (const hint of hints) lines.push(`    - ${hint}`);
	}
	lines.push('  task history:');
	lines.push(taskLines(entry.tasks, parsed.userTasks));
	const last = lastResultLine(entry);
	if (last) lines.push(last);
	return lines.join('\n');
}
