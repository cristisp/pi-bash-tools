import * as fs from 'node:fs';
import * as path from 'node:path';
import { flowReportsDir } from './flow.ts';
import type {
	BudgetSummary,
	DelegationContext,
	ReadManifest,
	ReportSummary,
	S4EscalationDirection,
	S4Lifecycle,
	S4Quality,
	S4QualitySignals,
	S4IndependentReviewStatus,
} from './types.ts';

const FENCED_BLOCK = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g;
const LEDGER_MARKER = /^[ \t]*workflow_version[ \t]*:/m;
const LEDGER_FIELD = /^[ \t]*([a-z][a-z0-9_]*)[ \t]*:[ \t]*(.*)$/;
const SIGNAL_FIELD =
	/(delegation_status|validation_verdict|review_verdict|verdict|escalat|blocker|unresolved|recommended_next_action|budget)\s*:/i;
const FILES_REVIEWED_HEADING = /^##[ \t]+Files Reviewed[ \t]*$/im;
const NEXT_H2_HEADING = /^##[ \t]+/gm;

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

export function normalizeS4Quality(value: unknown): S4Quality {
	if (typeof value !== 'string') return 'unknown';
	const normalized = value.trim().toLowerCase().replaceAll('-', '_');
	if (/^(pass|passed|ok|success|successful|complete|completed)$/.test(normalized)) return 'pass';
	if (/^(fail|failed|failure|error|errors)$/.test(normalized)) return 'fail';
	if (/^(incomplete|partial|blocked|unfinished)$/.test(normalized)) return 'incomplete';
	if (/^(none|not_run|notrun|skip|skipped|n_a|na)$/.test(normalized)) return 'not_run';
	return 'unknown';
}

function normalizeS4IndependentReviewStatus(value: string | undefined): S4IndependentReviewStatus {
	if (value === undefined) return 'unknown';
	const normalized = value.trim().toLowerCase().replaceAll('-', '_');
	if (/^(pass|passed|ok|success|successful)$/.test(normalized)) return 'pass';
	if (/^(fail|failed|failure|error|errors)$/.test(normalized)) return 'fail';
	if (/^(pending|in_progress|inprogress|not_run|notrun)$/.test(normalized)) return 'pending';
	return 'unknown';
}

function normalizeS4FieldValue(value: string): string {
	return value
		.trim()
		.replace(/[.!,:;]+$/, '')
		.toLowerCase();
}

function parseS4Boolean(value: string | undefined): boolean | null | undefined {
	if (value === undefined) return undefined;
	const normalized = normalizeS4FieldValue(value);
	if (/^(true|yes|1|pass|passed)\b/.test(normalized)) return true;
	if (/^(false|no|0|none|nothing|n\/a|na)\b/.test(normalized)) return false;
	return null;
}

function hasBlockingS4Field(value: string | undefined): boolean {
	const normalized = value === undefined ? '' : normalizeS4FieldValue(value);
	return Boolean(normalized && !/^(none|no|nothing|n\/a|na|-|\[\]|\{\})(\s|$)/.test(normalized));
}

export interface NormalizedS4Outcome {
	lifecycle: S4Lifecycle;
	quality: S4Quality;
	validationStatus: S4Quality;
	reviewStatus: S4Quality;
	budgetStatus: S4Quality;
	independentReviewStatus: S4IndependentReviewStatus;
	qualitySignals: S4QualitySignals;
}

/**
 * Converts existing report/ledger signals to the strict S4 vocabulary. Missing, malformed, and
 * contract-invalid signals intentionally remain non-passing; this function has no optimistic default.
 */
export function normalizeS4Outcome(
	fields: Record<string, string> | undefined,
	role: string,
	report?: ReportSummary,
	budget?: BudgetSummary,
	fallbackLifecycle: S4Lifecycle = 'unknown',
): NormalizedS4Outcome {
	const validationStatus = normalizeS4Quality(fields?.validation_verdict);
	const reviewStatus = normalizeS4Quality(fields?.review_verdict);
	const budgetStatus: S4Quality = budget
		? budget.outcome === 'within'
			? 'pass'
			: budget.outcome === 'aborted'
				? 'fail'
				: 'incomplete'
		: 'unknown';
	const unresolvedSignal = parseS4Boolean(fields?.unresolved_questions);
	// Findings and baseline failures are work product and evidence gaps that the verdict
	// fields already carry; they are not abandonment or unresolved-work blockers.
	const hasBlockingSignals =
		hasBlockingS4Field(fields?.environment_blockers) ||
		hasBlockingS4Field(fields?.unresolved_questions) ||
		hasBlockingS4Field(fields?.validation_omitted);
	const contractInvalid = Boolean(report?.contractIssues?.length) || report?.ledgerParsed === false;
	const missingLedger = fields === undefined;
	let lifecycle = fallbackLifecycle;
	const ledgerLifecycle = fields?.delegation_status?.trim().toLowerCase();
	if (lifecycle === 'unknown') {
		if (/^(aborted|abort|abandoned)$/.test(ledgerLifecycle ?? '')) lifecycle = 'abandoned';
		else if (/^(blocked|block)$/.test(ledgerLifecycle ?? '')) lifecycle = 'blocked';
		else if (/^(failed|failure|error)$/.test(ledgerLifecycle ?? '')) lifecycle = 'failed';
		else if (/^(settled|completed|complete|done)$/.test(ledgerLifecycle ?? ''))
			lifecycle = 'settled';
	}
	const independentReviewHandoff = parseS4Boolean(fields?.independent_review_handoff);
	const declaredIndependentReview = normalizeS4IndependentReviewStatus(
		fields?.independent_review_status,
	);
	const independentReviewStatus: S4IndependentReviewStatus =
		independentReviewHandoff === true ? declaredIndependentReview : 'pending';
	const componentStatusConsistent =
		!(
			[validationStatus, reviewStatus, budgetStatus].includes('pass') &&
			[validationStatus, reviewStatus, budgetStatus].includes('fail')
		) &&
		!(role === 'reviewer' && reviewStatus === 'pass' && validationStatus === 'fail') &&
		!(role === 'validator' && validationStatus === 'pass' && reviewStatus === 'fail');
	let quality: S4Quality;
	if (['failed', 'aborted', 'blocked', 'abandoned'].includes(lifecycle)) quality = 'fail';
	else if (lifecycle === 'unknown') quality = 'incomplete';
	else if (
		!componentStatusConsistent ||
		[validationStatus, reviewStatus, budgetStatus].includes('fail')
	)
		quality = 'fail';
	else if (
		missingLedger ||
		contractInvalid ||
		hasBlockingSignals ||
		unresolvedSignal === undefined ||
		unresolvedSignal === null
	)
		quality = 'incomplete';
	else if ([validationStatus, reviewStatus, budgetStatus].includes('unknown')) quality = 'unknown';
	else if ([validationStatus, reviewStatus, budgetStatus].includes('incomplete'))
		quality = 'incomplete';
	else if (role === 'reviewer' && reviewStatus !== 'pass') quality = 'incomplete';
	else if (role === 'validator' && validationStatus !== 'pass') quality = 'incomplete';
	else if (validationStatus === 'pass' || reviewStatus === 'pass') quality = 'pass';
	else if (validationStatus === 'not_run' && reviewStatus === 'not_run' && budgetStatus === 'pass')
		quality = 'pass';
	else quality = 'incomplete';
	const directionValue = fields?.escalation_direction?.trim().toLowerCase() as
		| S4EscalationDirection
		| undefined;
	const direction: S4EscalationDirection =
		directionValue && ['up', 'down', 'same', 'unknown'].includes(directionValue)
			? directionValue
			: 'unknown';
	const fromTier = fields?.escalation_from_tier ? Number(fields.escalation_from_tier) : null;
	const toTier = fields?.escalation_to_tier ? Number(fields.escalation_to_tier) : null;
	const qualitySignals: S4QualitySignals = {
		unresolvedOrAbandoned:
			lifecycle !== 'unknown'
				? lifecycle !== 'settled' || unresolvedSignal === true || hasBlockingSignals
				: (unresolvedSignal ?? null),
		reviewerPass: role === 'reviewer' ? reviewStatus === 'pass' : null,
		regressionAfterReviewPass: parseS4Boolean(fields?.regression_after_review_pass) ?? null,
		tier1DiscoveryFailure: parseS4Boolean(fields?.tier1_discovery_failure) ?? null,
		independentReviewStatus,
		componentStatusConsistent,
	};
	if (direction !== 'unknown' || (Number.isSafeInteger(fromTier) && Number.isSafeInteger(toTier))) {
		qualitySignals.escalation = {
			fromTier: Number.isSafeInteger(fromTier) ? fromTier : null,
			toTier: Number.isSafeInteger(toTier) ? toTier : null,
			direction,
		};
	}
	return {
		lifecycle,
		quality,
		validationStatus,
		reviewStatus,
		budgetStatus,
		independentReviewStatus,
		qualitySignals,
	};
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
	if (delegation.scope) meta.push(`- scope: ${JSON.stringify(delegation.scope)}`);
	if (delegation.reviewSurfacePath) meta.push(`- reviewSurface: ${delegation.reviewSurfacePath}`);
	if (delegation.reviewSurfaceHead)
		meta.push(`- reviewSurfaceHead: ${delegation.reviewSurfaceHead}`);
	const manifestPath = write.readManifest?.persistedPath ?? write.readManifest?.manifestPath;
	if (manifestPath) meta.push(`- readManifest: ${manifestPath}`);
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
