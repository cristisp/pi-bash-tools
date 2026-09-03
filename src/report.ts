import * as fs from 'node:fs';
import * as path from 'node:path';
import { flowReportsDir } from './flow.ts';
import type { DelegationContext } from './types.ts';

const FENCED_BLOCK = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g;
const LEDGER_MARKER = /^[ \t]*workflow_version[ \t]*:/m;
const LEDGER_FIELD = /^[ \t]*([a-z][a-z0-9_]*)[ \t]*:[ \t]*(.*)$/;
const SIGNAL_FIELD =
	/(delegation_status|validation_verdict|review_verdict|verdict|escalat|blocker|unresolved|recommended_next_action|budget)\s*:/i;

/** Character heuristic for budget arithmetic; the analyzer uses real token counts. */
export const CHARS_PER_TOKEN = 4;
const TRUNCATION_ALLOWANCE = 220;

export interface LedgerBlock {
	/** Field map from the last ledger-looking fenced block in the output. */
	fields: Record<string, string>;
	/** Ledger body without fences. */
	block: string;
	/** The full fenced block as it appeared, used to strip it from the remainder. */
	raw: string;
	index: number;
}

export function tokensFromChars(chars: number): number {
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function estimateTokens(text: string): number {
	return tokensFromChars(text.length);
}

export function parseLedgerBlock(output: string): LedgerBlock | null {
	let found: LedgerBlock | null = null;
	for (const match of output.matchAll(FENCED_BLOCK)) {
		const body = match[2] ?? '';
		if (!LEDGER_MARKER.test(body)) continue;
		const fields: Record<string, string> = {};
		for (const line of body.split('\n')) {
			const kv = LEDGER_FIELD.exec(line);
			if (kv) fields[kv[1] as string] = (kv[2] ?? '').trim();
		}
		found = { fields, block: body.trim(), raw: match[0], index: match.index ?? 0 };
	}
	return found;
}

export function signalLines(output: string, max = 8): string[] {
	const lines: string[] = [];
	for (const raw of output.split('\n')) {
		if (!SIGNAL_FIELD.test(raw)) continue;
		const line = raw.replace(/^[\s\-*>#]+/, '').trim();
		if (line && !lines.includes(line)) lines.push(line);
		if (lines.length >= max) break;
	}
	return lines;
}

export interface ReportDigest {
	digest: string;
	tokens: number;
	truncated: boolean;
	ledgerParsed: boolean;
}

/**
 * Compresses a child report into what the parent needs to decide: the ledger when the
 * child emitted one, otherwise its status lines, plus the head of the report.
 */
export function buildReportDigest(output: string, digestTokens: number): ReportDigest {
	const ledger = parseLedgerBlock(output);
	const remainder = ledger
		? output.slice(0, ledger.index) + output.slice(ledger.index + ledger.raw.length)
		: output;
	const budget = Math.max(digestTokens * CHARS_PER_TOKEN, CHARS_PER_TOKEN);
	const parts: string[] = [];
	if (ledger) {
		parts.push(`\`\`\`text\n${ledger.block}\n\`\`\``);
	} else {
		const signals = signalLines(remainder);
		if (signals.length > 0)
			parts.push(
				`Status lines (no ledger block emitted):\n${signals.map((s) => `- ${s}`).join('\n')}`,
			);
	}
	const headroom = Math.max(budget - parts.join('\n\n').length - 40, CHARS_PER_TOKEN);
	const body = remainder.trim();
	let truncated = false;
	if (body.length > headroom) {
		truncated = true;
		const keep = Math.max(headroom - TRUNCATION_ALLOWANCE, CHARS_PER_TOKEN);
		const omitted = tokensFromChars(body.length - keep);
		parts.push(
			`${body.slice(0, keep).trimEnd()}\n[Digest truncated: ~${omitted} tokens omitted from the report body.]`,
		);
	} else if (body) {
		parts.push(body);
	}
	const digest = parts.join('\n\n').trim();
	return { digest, tokens: estimateTokens(digest), truncated, ledgerParsed: ledger !== null };
}

export interface RoleReportWrite {
	flowId?: string;
	label: string;
	delegation: DelegationContext;
	output: string;
	now?: number;
}

/** Persists the full child report inside its flow; returns undefined when nothing was written. */
export function writeRoleReport(write: RoleReportWrite): string | undefined {
	if (!write.flowId) return undefined;
	const now = write.now ?? Date.now();
	const dir = flowReportsDir(write.flowId);
	const file = path.join(dir, `${sanitizeName(write.label)}-${now}.md`);
	const { delegation } = write;
	const meta = [
		`- flow: ${delegation.flowId ?? 'none'}`,
		`- delegation: ${delegation.delegationId}`,
		`- role: ${delegation.role}`,
		`- evidenceScope: ${delegation.evidenceScope}`,
	];
	if (typeof delegation.tier === 'number') meta.push(`- tier: ${delegation.tier}`);
	if (delegation.workflowMode) meta.push(`- mode: ${delegation.workflowMode}`);
	if (delegation.reviewMode) meta.push(`- reviewMode: ${delegation.reviewMode}`);
	if (delegation.acceptanceCriteria?.length)
		meta.push(`- criteria: ${delegation.acceptanceCriteria.join(', ')}`);
	const doc = `# Role report: ${write.label} (${delegation.role})\n\n${meta.join('\n')}\n- completedAt: ${new Date(now).toISOString()}\n- reportTokens: ~${estimateTokens(write.output)}\n\n---\n\n${write.output}\n`;
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(file, doc, 'utf-8');
		return file;
	} catch {
		return undefined;
	}
}

function sanitizeName(value: string): string {
	return value.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '') || 'report';
}
