import * as fs from 'node:fs';
import * as path from 'node:path';
import { flowReportsDir } from './flow.ts';
import { oneLine } from './ledger.ts';
import type { DelegationContext, ReadManifest, ReadManifestStatus } from './types.ts';

const FENCED_BLOCK = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g;
const LEDGER_MARKER = /^[ \t]*workflow_version[ \t]*:/m;
const LEDGER_FIELD = /^[ \t]*([a-z][a-z0-9_]*)[ \t]*:[ \t]*(.*)$/;
const SIGNAL_FIELD =
	/(delegation_status|validation_verdict|review_verdict|verdict|escalat|blocker|unresolved|recommended_next_action|budget)\s*:/i;
const FILES_REVIEWED_HEADING = /^##[ \t]+Files Reviewed[ \t]*$/im;
const NEXT_H2_HEADING = /^##[ \t]+/gm;

/** Character heuristic for budget arithmetic; the analyzer uses real token counts. */
const CHARS_PER_TOKEN = 4;
const TRUNCATION_ALLOWANCE = 220;

export interface LedgerBlock {
	/** Field map from the last ledger-looking fenced block in the output. */
	fields: Record<string, string>;
	/** Ledger body without fences. */
	block: string;
	/** The full fenced block as it appeared, used to strip it from the remainder. */
	raw: string;
	index: number;
	/** Whether the report included a `## Files Reviewed` section. */
	filesReviewedPresent: boolean;
	/** Paths extracted from the reviewer inspection section. */
	filesReviewed: string[];
}

export function tokensFromChars(chars: number): number {
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function estimateTokens(text: string): number {
	return tokensFromChars(text.length);
}

export function parseFilesReviewed(output: string): string[] | undefined {
	const heading = FILES_REVIEWED_HEADING.exec(output);
	if (!heading || heading.index === undefined) return undefined;
	const start = heading.index + heading[0].length;
	NEXT_H2_HEADING.lastIndex = start;
	const next = NEXT_H2_HEADING.exec(output);
	const section = output.slice(start, next?.index ?? output.length);
	const paths: string[] = [];
	for (const rawLine of section.split('\n')) {
		const line = rawLine.trim();
		if (!/^[-*+][ \t]+/.test(line)) continue;
		let item = line.replace(/^[-*+][ \t]+/, '').trim();
		if (!item || /^(none|no files reviewed)\.?$/i.test(item)) continue;
		item = item.split(/\s+-\s+/, 1)[0].trim();
		const link = /^\[([^\]]+)\]\([^)]*\)/.exec(item);
		if (link) item = link[1].trim();
		item = item.replace(/:\s*(?:line[- ]?range|lines?|L)?\s*\d+(?:[-,]\d+)*$/i, '').trim();
		item = item.replace(/:\s*(?:line[- ]?range|lines?)$/i, '').trim();
		if (item && !paths.includes(item)) paths.push(item);
	}
	return paths;
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
		const filesReviewed = parseFilesReviewed(output);
		if (filesReviewed !== undefined) fields.changed_files = filesReviewed.join(',');
		found = {
			fields,
			block: body.trim(),
			raw: match[0],
			index: match.index ?? 0,
			filesReviewedPresent: filesReviewed !== undefined,
			filesReviewed: filesReviewed ?? [],
		};
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
	filesReviewedPresent: boolean;
	filesReviewed: string[];
	contractIssues: string[];
}

/**
 * Compresses a child report into what the parent needs to decide: the ledger when the
 * child emitted one, otherwise its status lines, plus the head of the report.
 */
export function buildReportDigest(
	output: string,
	digestTokens: number,
	options: { requireFilesReviewed?: boolean } = {},
): ReportDigest {
	const ledger = parseLedgerBlock(output);
	const filesReviewed = parseFilesReviewed(output);
	const contractIssues =
		options.requireFilesReviewed && filesReviewed === undefined
			? ['missing required ## Files Reviewed section']
			: [];
	const remainder = ledger
		? output.slice(0, ledger.index) + output.slice(ledger.index + ledger.raw.length)
		: output;
	const budget = Math.max(digestTokens * CHARS_PER_TOKEN, CHARS_PER_TOKEN);
	const parts: string[] = [];
	if (ledger) {
		// Cap each field value exactly the way the flow ledger does, so one verbose child cannot
		// reach orchestrator context with values the ledger would have capped.
		const capped = ledger.block
			.split('\n')
			.map((line) => {
				const kv = LEDGER_FIELD.exec(line);
				return kv ? `${kv[1]}: ${oneLine(kv[2] ?? '')}` : line;
			})
			.join('\n');
		parts.push(`\`\`\`text\n${capped}\n\`\`\``);
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
	if (contractIssues.length > 0) {
		parts.unshift(`Report contract: ${contractIssues.join('; ')}.`);
	}
	const digest = parts.join('\n\n').trim();
	return {
		digest,
		tokens: estimateTokens(digest),
		truncated,
		ledgerParsed: ledger !== null,
		filesReviewedPresent: filesReviewed !== undefined,
		filesReviewed: filesReviewed ?? [],
		contractIssues,
	};
}

export interface RoleReportWrite {
	flowId?: string;
	label: string;
	delegation: DelegationContext;
	readManifest?: ReadManifest;
	readManifestStatus?: ReadManifestStatus;
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
	if (delegation.contextMode) meta.push(`- contextMode: ${delegation.contextMode}`);
	if (delegation.contextReason) meta.push(`- contextReason: ${delegation.contextReason}`);
	if (delegation.acceptanceCriteria?.length)
		meta.push(`- criteria: ${delegation.acceptanceCriteria.join(', ')}`);
	if (delegation.scope) meta.push(`- scope: ${JSON.stringify(delegation.scope)}`);
	if (delegation.reviewSurfacePath) meta.push(`- reviewSurface: ${delegation.reviewSurfacePath}`);
	if (delegation.reviewSurfaceHead)
		meta.push(`- reviewSurfaceHead: ${delegation.reviewSurfaceHead}`);
	const manifestPath = write.readManifest?.persistedPath ?? write.readManifest?.manifestPath;
	if (manifestPath) meta.push(`- readManifest: ${manifestPath}`);
	if (write.readManifestStatus) meta.push(`- readManifestStatus: ${write.readManifestStatus}`);
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
