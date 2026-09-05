import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { TelemetryRecord } from '../src/types.ts';

/** Same estimator `analysis-0903-full.md` used, so numbers stay comparable to the baseline. */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(chars: number): number {
	return Math.round(chars / CHARS_PER_TOKEN);
}

export interface Quantiles {
	count: number;
	avg: number;
	p50: number;
	p95: number;
	p99: number;
	max: number;
}

export function quantiles(values: number[]): Quantiles {
	if (values.length === 0) {
		return { count: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
	}
	const sorted = values.toSorted((a, b) => a - b);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
	const sum = sorted.reduce((acc, n) => acc + n, 0);
	return {
		count: sorted.length,
		avg: Math.round(sum / sorted.length),
		p50: at(0.5),
		p95: at(0.95),
		p99: at(0.99),
		max: sorted[sorted.length - 1],
	};
}

export interface DeliveredResult {
	/** Absolute path of the session file that received this `subagent` tool result. */
	sessionFile: string;
	/** Whether this session is a child spawned by the extension. */
	child: boolean;
	at: number;
	chars: number;
	tokens: number;
	/** Result tokens x assistant turns that happened after it in the same session. */
	carryTokens: number;
	/** Report path when the delivered text carried `[full report: <path>]`. */
	reportPath?: string;
}

export interface SessionScan {
	roots: number;
	children: number;
	/** Modified time of the session file, used to scope attribution to the telemetry window. */
	fileMtimeMs: number;
	results: DeliveredResult[];
	/** Estimated tokens re-read from context because a result stayed in it. */
	carryTokens: number;
	/** Subagent result tokens a root session received in total. */
	receivedTokens: number;
	/** Root-session read requests targeting a flow report file. */
	reportReads: number;
	reportReadTimestamps: number[];
	/** Root-session read requests targeting the orchestration guide. */
	guideReads: number;
	guideReadTimestamps: number[];
}

const REPORT_PATH_RE = /\[full report: ([^\]\s]+)\]/;

/** The guide the tool description and child prompts replaced, and the name it was retired from. */
const GUIDE_FILENAME = 'subagent_orchestration.md';
const RETIRED_GUIDE_FILENAME = 'SUBAGENTS_GUIDE.md';
const GUIDE_FILENAMES = new Set([GUIDE_FILENAME, RETIRED_GUIDE_FILENAME]);

function contentChars(message: { content?: unknown }): number {
	if (typeof message.content === 'string') return message.content.length;
	if (!Array.isArray(message.content)) return 0;
	let chars = 0;
	for (const block of message.content as Array<{ type?: string; text?: string }>) {
		if (block?.type === 'text' && typeof block.text === 'string') chars += block.text.length;
	}
	return chars;
}

function resultText(message: { content?: unknown }): string {
	if (typeof message.content === 'string') return message.content;
	if (!Array.isArray(message.content)) return '';
	return (message.content as Array<{ type?: string; text?: string }>)
		.map((block) => (block?.type === 'text' ? (block.text ?? '') : ''))
		.join('\n');
}

interface SessionMessage {
	type?: string;
	timestamp?: string | number;
	message?: { role?: string; toolName?: string; content?: unknown };
}

interface SessionContentBlock {
	type?: string;
	text?: string;
	name?: string;
	toolName?: string;
	arguments?: unknown;
	input?: unknown;
}

function contentBlocks(message: { content?: unknown }): SessionContentBlock[] {
	return Array.isArray(message.content) ? (message.content as SessionContentBlock[]) : [];
}

function toolArguments(block: SessionContentBlock): Record<string, unknown> | null {
	const value = block.arguments ?? block.input;
	if (typeof value === 'string') {
		try {
			const parsed: unknown = JSON.parse(value);
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: null;
		} catch {
			return null;
		}
	}
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function isFlowReportPath(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const segments = value.replaceAll('\\', '/').split('/').filter(Boolean);
	return segments.some(
		(segment, index) =>
			segment === 'flows' &&
			Boolean(segments[index + 1]) &&
			segments[index + 2] === 'reports' &&
			Boolean(segments[index + 3]?.endsWith('.md')) &&
			index + 4 === segments.length,
	);
}

function isGuidePath(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const segments = value.replaceAll('\\', '/').split('/').filter(Boolean);
	return GUIDE_FILENAMES.has(segments[segments.length - 1] ?? '');
}

type PathMatch = (path: unknown) => boolean;

/** Timestamps of the `read` tool calls in one assistant turn whose path satisfies `isMatch`. */
function readCallTimes(entry: SessionMessage, isMatch: PathMatch): number[] {
	if (entry.message?.role !== 'assistant') return [];
	const at = Date.parse(String(entry.timestamp ?? '')) || 0;
	return contentBlocks(entry.message)
		.filter((block) => {
			const type = block.type;
			const name = block.name ?? block.toolName;
			if (type !== 'toolCall' && type !== 'tool_use') return false;
			if (name !== 'read') return false;
			return isMatch(toolArguments(block)?.path);
		})
		.map(() => at);
}

function reportReadTimestamps(entry: SessionMessage): number[] {
	return readCallTimes(entry, isFlowReportPath);
}

function guideReadTimestamps(entry: SessionMessage): number[] {
	return readCallTimes(entry, isGuidePath);
}

export function scanSession(filePath: string, child: boolean): SessionScan {
	const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
	const parsed: SessionMessage[] = [];
	for (const line of lines) {
		try {
			parsed.push(JSON.parse(line) as SessionMessage);
		} catch {
			// A torn final line is normal in a live session file.
		}
	}
	const scan: SessionScan = {
		roots: child ? 0 : 1,
		children: child ? 1 : 0,
		fileMtimeMs: statSync(filePath).mtimeMs,
		results: [],
		carryTokens: 0,
		receivedTokens: 0,
		reportReads: 0,
		reportReadTimestamps: [],
		guideReads: 0,
		guideReadTimestamps: [],
	};
	if (!child) {
		for (const entry of parsed) {
			scan.reportReadTimestamps.push(...reportReadTimestamps(entry));
			scan.guideReadTimestamps.push(...guideReadTimestamps(entry));
		}
		scan.reportReads = scan.reportReadTimestamps.length;
		scan.guideReads = scan.guideReadTimestamps.length;
	}
	const assistantAt: number[] = [];
	parsed.forEach((entry, index) => {
		if (entry.message?.role === 'assistant') assistantAt.push(index);
	});
	parsed.forEach((entry, index) => {
		const msg = entry.message;
		if (msg?.role !== 'toolResult' || msg.toolName !== 'subagent') return;
		const chars = contentChars(msg);
		const tokens = estimateTokens(chars);
		const matched = REPORT_PATH_RE.exec(resultText(msg));
		const later = assistantAt.filter((assistantIndex) => assistantIndex > index).length;
		const carryTokens = tokens * later;
		scan.results.push({
			sessionFile: filePath,
			child,
			at: Date.parse(String(entry.timestamp ?? '')) || 0,
			chars,
			tokens,
			carryTokens,
			reportPath: matched?.[1],
		});
		scan.receivedTokens += tokens;
		scan.carryTokens += carryTokens;
	});
	return scan;
}

export function sessionFiles(agentDir: string): { path: string; child: boolean }[] {
	const dir = join(agentDir, 'sessions');
	if (!existsSync(dir)) return [];
	const out: { path: string; child: boolean }[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isFile() && entry.name.endsWith('.jsonl')) {
			out.push({ path: full, child: entry.name.startsWith('subagent-') });
			continue;
		}
		if (!entry.isDirectory()) continue;
		for (const inner of readdirSync(full, { withFileTypes: true })) {
			if (inner.isFile() && inner.name.endsWith('.jsonl')) {
				out.push({ path: join(full, inner.name), child: false });
			}
		}
	}
	return out;
}

export function readTelemetry(agentDir: string): TelemetryRecord[] {
	const file = join(agentDir, 'subagent-herdr.telemetry.jsonl');
	if (!existsSync(file)) return [];
	const records: TelemetryRecord[] = [];
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as TelemetryRecord;
			if (parsed?.v === 1) records.push(parsed);
		} catch {
			// Ignore unreadable lines rather than failing the measurement run.
		}
	}
	return records;
}

export function defaultCutoff(records: TelemetryRecord[]): number {
	const withReport = records.filter((r) => r.report).map((r) => r.at);
	return withReport.length ? Math.min(...withReport) : Number.POSITIVE_INFINITY;
}

export function firstTelemetryAt(records: TelemetryRecord[]): number {
	return records.length ? Math.min(...records.map((r) => r.at)) : Number.POSITIVE_INFINITY;
}

/** Root-session guide reads plus the size of the guide the tool description replaced. */
export interface GuideMeasurement {
	reads: number;
	readsBefore: number;
	readsAfter: number;
	readsPerRoot: number;
	readsPerRootBefore: number;
	readsPerRootAfter: number;
	renderedChars: number;
	/** Estimated tokens of `agents/subagent_orchestration.md`; null when that file is absent. */
	renderedTokens: number | null;
}

/** Validation evidence carried by telemetry, aggregated over one scope: overall, or a single role. */
export interface ValidationEvidence {
	scope: string;
	delegations: number;
	delegationsWithRefs: number;
	refsMinted: number;
	/** Minted refs whose run executed the gate rather than reusing stored evidence. */
	refsExecuted: number;
	refsReused: number;
	/** Calls that resolved an existing ref instead of running the gate. */
	refsResolvedByLookup: number;
	fullValidationPasses: number;
	/** Distinct `stateDigest` values across minted refs, counted inside one flow then summed. */
	distinctStateDigests: number;
	/** Executed mints per distinct digest; null when no flow minted a digest-bearing ref. */
	executionsPerDigest: number | null;
}

export interface Measurement {
	agentDir: string;
	windowFrom: number;
	windowTo: number;
	rootSessions: number;
	childSessions: number;
	telemetryRecords: number;
	cutoff: number;
	delivered: { all: Quantiles; before: Quantiles; after: Quantiles; childResults: number };
	carry: {
		rootCarryTokens: number;
		rootReceivedTokens: number;
		delegatingRoots: number;
		meanCarryPerDelegatingRoot: number;
		beforeCarryTokens: number;
		afterCarryTokens: number;
		meanCarryPerDelegatingRootBefore: number;
		meanCarryPerDelegatingRootAfter: number;
		delegatingRootsBefore: number;
		delegatingRootsAfter: number;
	};
	joined: number;
	reportTurns: number;
	rootReportReads: number;
	rootReportReadsBefore: number;
	rootReportReadsAfter: number;
	guide: GuideMeasurement;
	validation: { overall: ValidationEvidence; byRole: ValidationEvidence[] };
	telemetryFrom: number;
	childrenInTelemetryWindow: number;
	byRole: {
		role: string;
		turns: number;
		medianFull: number;
		medianDigest: number;
		ledgerParsed: number;
		cost: number;
	}[];
	unattributedChildren: number;
	/** Sum of child spend from telemetry. Root spend is not in telemetry and stays analyzer-side. */
	childrenCost: number;
}

function tokensOf(list: DeliveredResult[]): number[] {
	return list.map((r) => r.tokens);
}

function carryOf(list: DeliveredResult[]): number {
	return list.reduce((acc, r) => acc + r.carryTokens, 0);
}

function perRoot(tokens: number, roots: number): number {
	return roots ? Math.round(tokens / roots) : 0;
}

function perRootReads(reads: number, roots: number): number {
	return roots ? Number((reads / roots).toFixed(2)) : 0;
}

/** Size of the rendered guide under the same chars / 4 estimator; absent means null, not zero. */
function guideRenderSize(agentDir: string): { chars: number; tokens: number | null } {
	const file = join(agentDir, 'agents', GUIDE_FILENAME);
	if (!existsSync(file)) return { chars: 0, tokens: null };
	const chars = readFileSync(file, 'utf8').length;
	return { chars, tokens: estimateTokens(chars) };
}

/**
 * Tally the `verify` refs one set of delegations carries. Deduplication happens inside one flow: refs
 * are grouped by `flowId`, the distinct `stateDigest` values of the refs minted there are counted, and
 * executed mints are divided by that count, so a ratio above 1 is a gate executed again over state that
 * was already validated. A mint without a `stateDigest` cannot be deduplicated at all, so flows whose
 * refs carry no digest stay out of the ratio instead of contributing a guessed denominator.
 */
function tallyValidation(records: TelemetryRecord[], scope: string): ValidationEvidence {
	const digests = new Map<string, Set<string>>();
	const executedInFlow = new Map<string, number>();
	let delegations = 0;
	let delegationsWithRefs = 0;
	let refsMinted = 0;
	let refsExecuted = 0;
	let refsReused = 0;
	let refsResolvedByLookup = 0;
	let fullValidationPasses = 0;
	for (const record of records) {
		delegations++;
		fullValidationPasses += record.metrics?.fullValidationPasses ?? 0;
		const refs = record.metrics?.validationRefs ?? [];
		if (refs.length) delegationsWithRefs++;
		const flow = record.flowId ?? '-';
		for (const ref of refs) {
			if (ref.lookup) {
				refsResolvedByLookup++;
				continue;
			}
			refsMinted++;
			if (ref.reused) refsReused++;
			else refsExecuted++;
			const digestsHere = digests.get(flow) ?? new Set<string>();
			digests.set(flow, digestsHere);
			executedInFlow.set(flow, (executedInFlow.get(flow) ?? 0) + (ref.reused ? 0 : 1));
			if (ref.stateDigest) digestsHere.add(ref.stateDigest);
		}
	}
	let distinctStateDigests = 0;
	let digestibleExecutions = 0;
	for (const [flow, set] of digests) {
		if (!set.size) continue;
		distinctStateDigests += set.size;
		digestibleExecutions += executedInFlow.get(flow) ?? 0;
	}
	return {
		scope,
		delegations,
		delegationsWithRefs,
		refsMinted,
		refsExecuted,
		refsReused,
		refsResolvedByLookup,
		fullValidationPasses,
		distinctStateDigests,
		executionsPerDigest: distinctStateDigests
			? Number((digestibleExecutions / distinctStateDigests).toFixed(2))
			: null,
	};
}

export function measure(
	agentDir: string,
	cutoff = defaultCutoff(readTelemetry(agentDir)),
): Measurement {
	const records = readTelemetry(agentDir);
	const files = sessionFiles(agentDir);
	const telemetryFrom = firstTelemetryAt(records);
	const results: DeliveredResult[] = [];
	let rootSessions = 0;
	let childSessions = 0;
	let rootCarryTokens = 0;
	let rootReceivedTokens = 0;
	let delegatingRoots = 0;
	let delegatingRootsBefore = 0;
	let delegatingRootsAfter = 0;
	let childrenInWindow = 0;
	let unattributedChildren = 0;
	let rootReportReads = 0;
	let rootReportReadsBefore = 0;
	let rootReportReadsAfter = 0;
	let rootGuideReads = 0;
	let rootGuideReadsBefore = 0;
	let rootGuideReadsAfter = 0;
	const telemetryChildFiles = new Set(
		records.map((r) => r.sessionFile).filter((f): f is string => Boolean(f)),
	);
	for (const file of files) {
		const scan = scanSession(file.path, file.child);
		rootSessions += scan.roots;
		childSessions += scan.children;
		results.push(...scan.results);
		if (file.child) {
			if (scan.fileMtimeMs >= telemetryFrom) {
				childrenInWindow++;
				if (!telemetryChildFiles.has(file.path)) unattributedChildren++;
			}
			continue;
		}
		rootCarryTokens += scan.carryTokens;
		rootReceivedTokens += scan.receivedTokens;
		rootReportReads += scan.reportReads;
		rootReportReadsBefore += scan.reportReadTimestamps.filter((at) => at > 0 && at < cutoff).length;
		rootReportReadsAfter += scan.reportReadTimestamps.filter((at) => at >= cutoff).length;
		rootGuideReads += scan.guideReads;
		rootGuideReadsBefore += scan.guideReadTimestamps.filter((at) => at > 0 && at < cutoff).length;
		rootGuideReadsAfter += scan.guideReadTimestamps.filter((at) => at >= cutoff).length;
		if (!scan.results.length) continue;
		delegatingRoots++;
		if (scan.results.some((r) => r.at < cutoff)) delegatingRootsBefore++;
		if (scan.results.some((r) => r.at >= cutoff)) delegatingRootsAfter++;
	}
	const timestamps = results.map((r) => r.at).filter((t) => t > 0);
	const beforeResults = results.filter((r) => r.at < cutoff);
	const afterResults = results.filter((r) => r.at >= cutoff);

	const byReportPath = new Map<string, TelemetryRecord>();
	for (const record of records) {
		if (record.report?.path) byReportPath.set(record.report.path, record);
	}
	let joined = 0;
	for (const result of results) {
		if (result.reportPath && byReportPath.has(result.reportPath)) joined++;
	}

	const reportTurns = records.filter((r) => r.report);
	const roles = new Map<string, TelemetryRecord[]>();
	for (const record of reportTurns) {
		const list = roles.get(record.role) ?? [];
		list.push(record);
		roles.set(record.role, list);
	}
	const byRole = [...roles.entries()]
		.map(([role, list]) => ({
			role,
			turns: list.length,
			medianFull: quantiles(list.map((r) => r.report?.tokens ?? 0)).p50,
			medianDigest: quantiles(list.map((r) => r.report?.digestTokens ?? 0)).p50,
			ledgerParsed: list.filter((r) => r.report?.ledgerParsed).length,
			cost: Number(list.reduce((acc, r) => acc + (r.usage?.cost ?? 0), 0).toFixed(4)),
		}))
		.toSorted((a, b) => b.turns - a.turns);

	const validationRoles = new Map<string, TelemetryRecord[]>();
	for (const record of records) {
		const list = validationRoles.get(record.role) ?? [];
		list.push(record);
		validationRoles.set(record.role, list);
	}
	const guideSize = guideRenderSize(agentDir);
	const beforeCarryTokens = carryOf(beforeResults);
	const afterCarryTokens = carryOf(afterResults);

	return {
		agentDir,
		windowFrom: timestamps.length ? Math.min(...timestamps) : 0,
		windowTo: timestamps.length ? Math.max(...timestamps) : 0,
		rootSessions,
		childSessions,
		telemetryRecords: records.length,
		telemetryFrom,
		cutoff,
		delivered: {
			all: quantiles(tokensOf(results)),
			before: quantiles(tokensOf(beforeResults)),
			after: quantiles(tokensOf(afterResults)),
			childResults: results.filter((r) => r.child).length,
		},
		carry: {
			rootCarryTokens,
			rootReceivedTokens,
			delegatingRoots,
			meanCarryPerDelegatingRoot: perRoot(rootCarryTokens, delegatingRoots),
			beforeCarryTokens,
			afterCarryTokens,
			meanCarryPerDelegatingRootBefore: perRoot(beforeCarryTokens, delegatingRootsBefore),
			meanCarryPerDelegatingRootAfter: perRoot(afterCarryTokens, delegatingRootsAfter),
			delegatingRootsBefore,
			delegatingRootsAfter,
		},
		joined,
		reportTurns: reportTurns.length,
		rootReportReads,
		rootReportReadsBefore,
		rootReportReadsAfter,
		guide: {
			reads: rootGuideReads,
			readsBefore: rootGuideReadsBefore,
			readsAfter: rootGuideReadsAfter,
			readsPerRoot: perRootReads(rootGuideReads, delegatingRoots),
			readsPerRootBefore: perRootReads(rootGuideReadsBefore, delegatingRootsBefore),
			readsPerRootAfter: perRootReads(rootGuideReadsAfter, delegatingRootsAfter),
			renderedChars: guideSize.chars,
			renderedTokens: guideSize.tokens,
		},
		validation: {
			overall: tallyValidation(records, 'overall'),
			byRole: [...validationRoles.entries()]
				.map(([role, list]) => tallyValidation(list, role))
				.toSorted((a, b) => b.delegations - a.delegations || a.scope.localeCompare(b.scope)),
		},
		byRole,
		childrenInTelemetryWindow: childrenInWindow,
		unattributedChildren,
		childrenCost: Number(records.reduce((acc, r) => acc + (r.usage?.cost ?? 0), 0).toFixed(4)),
	};
}

function row(cells: (string | number)[]): string {
	return `| ${cells.join(' | ')} |`;
}

/** Duplicate execution measured before this workstream existed, quoted from the plan it came from. */
const VALIDATION_BASELINE_LABEL =
	'baseline 2026-09-05 plan: 1,075 duplicate project_command calls, 49.7% of them';

const validationColumns = [
	'scope',
	'delegations',
	'delegations with refs',
	'refs minted',
	'refs executed',
	'refs reused',
	'refs by lookup',
	'full validation passes',
	'distinct state digests',
	'executions per digest',
];

function validationCells(v: ValidationEvidence): (string | number)[] {
	return [
		v.scope,
		v.delegations,
		v.delegationsWithRefs,
		v.refsMinted,
		v.refsExecuted,
		v.refsReused,
		v.refsResolvedByLookup,
		v.fullValidationPasses,
		v.distinctStateDigests,
		v.executionsPerDigest === null ? '-' : v.executionsPerDigest.toFixed(2),
	];
}

function date(t: number): string {
	return Number.isFinite(t) && t > 0 ? new Date(t).toISOString().slice(0, 16) : '-';
}

export function renderMarkdown(m: Measurement): string {
	const lines: string[] = [];
	lines.push('# Orchestration measurement');
	lines.push('');
	lines.push(
		`Agent dir \`${m.agentDir}\`. Window ${date(m.windowFrom)} .. ${date(m.windowTo)}. ` +
			`${m.rootSessions} root sessions, ${m.childSessions} child sessions, ` +
			`${m.telemetryRecords} telemetry records. Report cutoff ${date(m.cutoff)}.`,
	);
	lines.push('');
	lines.push('## Delivered `subagent` result size (estimated tokens, chars / 4)');
	lines.push('');
	lines.push(row(['window', 'n', 'avg', 'p50', 'p95', 'p99', 'max']));
	lines.push(row(['---', '---:', '---:', '---:', '---:', '---:', '---:']));
	const q = (label: string, v: Quantiles) =>
		row([label, v.count, v.avg, v.p50, v.p95, v.p99, v.max]);
	lines.push(q('before cutoff', m.delivered.before));
	lines.push(q('at or after cutoff', m.delivered.after));
	lines.push(q('all', m.delivered.all));
	lines.push(row(['baseline 2026-08-26..09-02', 285, 1821, 900, '-', 6099, '-']));
	lines.push('');
	lines.push('## Report digest fidelity (telemetry turns carrying a report)');
	lines.push('');
	lines.push(
		`Delivered results joined to a telemetry report by report path: ${m.joined} / ${m.reportTurns}.`,
	);
	lines.push('');
	lines.push(
		row(['role', 'turns', 'median full', 'median digest', 'digest/full', 'ledger', 'cost']),
	);
	lines.push(row(['---', '---:', '---:', '---:', '---:', '---:', '---:']));
	for (const r of m.byRole) {
		const ratio = r.medianFull ? `${Math.round((r.medianDigest / r.medianFull) * 100)}%` : '-';
		lines.push(
			row([
				r.role,
				r.turns,
				r.medianFull,
				r.medianDigest,
				ratio,
				`${r.ledgerParsed}/${r.turns}`,
				`$${r.cost.toFixed(4)}`,
			]),
		);
	}
	lines.push('');
	lines.push('## Root report reads (the W3 Slice D signal)');
	lines.push('');
	lines.push(
		'These are root-session read requests targeting files under `flows/*/reports/*.md`; child ' +
			'session reads are excluded.',
	);
	lines.push('');
	lines.push(row(['window', 'report reads']));
	lines.push(row(['---', '---:']));
	lines.push(row(['before cutoff', m.rootReportReadsBefore]));
	lines.push(row(['at or after cutoff', m.rootReportReadsAfter]));
	lines.push(row(['all', m.rootReportReads]));
	lines.push('');
	lines.push('## Root carry (the W3 target)');
	lines.push('');
	lines.push(
		'Carry is result tokens x the number of later assistant turns in the same root session, i.e. how ' +
			'often that text re-entered the model before the session ended.',
	);
	lines.push('');
	lines.push(
		row(['window', 'results', 'delegating roots', 'carry (token-times)', 'carry per root']),
	);
	lines.push(row(['---', '---:', '---:', '---:', '---:']));
	lines.push(
		row([
			'before cutoff',
			m.delivered.before.count,
			m.carry.delegatingRootsBefore,
			m.carry.beforeCarryTokens.toLocaleString(),
			m.carry.meanCarryPerDelegatingRootBefore.toLocaleString(),
		]),
	);
	lines.push(
		row([
			'at or after cutoff',
			m.delivered.after.count,
			m.carry.delegatingRootsAfter,
			m.carry.afterCarryTokens.toLocaleString(),
			m.carry.meanCarryPerDelegatingRootAfter.toLocaleString(),
		]),
	);
	lines.push(
		row([
			'all',
			m.delivered.all.count,
			m.carry.delegatingRoots,
			m.carry.rootCarryTokens.toLocaleString(),
			m.carry.meanCarryPerDelegatingRoot.toLocaleString(),
		]),
	);
	lines.push('');
	lines.push(
		`Root sessions received ${m.carry.rootReceivedTokens.toLocaleString()} estimated tokens of ` +
			'subagent results in total.',
	);
	lines.push('');
	lines.push(
		`Child sessions created since telemetry began (${date(m.telemetryFrom)}): ` +
			`${m.childrenInTelemetryWindow}, of which ${m.unattributedChildren} have no telemetry record. ` +
			'Historic children cannot be attributed and are excluded.',
	);
	lines.push('');
	lines.push(
		`Child spend recorded in telemetry: $${m.childrenCost.toFixed(4)} across ${m.telemetryRecords} turns.`,
	);
	lines.push('');
	lines.push('## Validation evidence (the W7 target)');
	lines.push('');
	lines.push(
		'Per role and overall: delegations carrying a `verify` ref, refs minted, refs ' +
			'executed rather than reused, refs resolved by lookup, full validation passes ' +
			'charged, and executions per distinct repository-state digest. Deduplication means ' +
			'grouping records by `flowId`, counting the distinct `stateDigest` values across the ' +
			'refs minted in that flow, and dividing executed mints by that count, because a ratio ' +
			'above 1 is the duplicate execution this workstream exists to remove.',
	);
	lines.push('');
	lines.push(row(validationColumns));
	lines.push(row(['---', '---:', '---:', '---:', '---:', '---:', '---:', '---:', '---:', '---:']));
	lines.push(row(validationCells(m.validation.overall)));
	for (const v of m.validation.byRole) {
		lines.push(row(validationCells(v)));
	}
	lines.push(row([VALIDATION_BASELINE_LABEL, ...validationColumns.slice(1).map(() => '-')]));
	lines.push('');
	lines.push(
		'Every ref counted here was minted by a delegated child seat, because root ' +
			'spend is not in telemetry. Minting works and is authorized per `verify` call shape, so a zero ' +
			'here after children ran the gate means the shape was refused (`F9` in ' +
			'`analysis/BASH_TOOLS_FOLLOWUPS.md`) rather than that validation was deduplicated.',
	);
	lines.push('');
	lines.push('## Guide reads and rendered size (the W8 target)');
	lines.push('');
	lines.push(
		'The `subagent` tool description and the child prompts now carry what used to ' +
			'require a guide read, so this counts root-session `read` requests whose path ends in ' +
			'`subagent_orchestration.md` or the retired `SUBAGENTS_GUIDE.md`, and prices the rendered ' +
			'guide itself with the same chars / 4 estimator. Child-session reads are excluded, just ' +
			'as flow-report reads are above.',
	);
	lines.push('');
	lines.push(row(['window', 'guide reads', 'reads per delegating root']));
	lines.push(row(['---', '---:', '---:']));
	const guideRow = (label: string, reads: number, mean: number) =>
		row([label, reads, mean.toFixed(2)]);
	lines.push(guideRow('before cutoff', m.guide.readsBefore, m.guide.readsPerRootBefore));
	lines.push(guideRow('at or after cutoff', m.guide.readsAfter, m.guide.readsPerRootAfter));
	lines.push(guideRow('all', m.guide.reads, m.guide.readsPerRoot));
	lines.push(row(['rendered guide (est. tokens)', m.guide.renderedTokens ?? '-', '-']));
	lines.push('');
	lines.push(
		`Rendered guide source \`agents/${GUIDE_FILENAME}\` at ${m.guide.renderedChars} chars; ` +
			'the size reads `-` when that file is absent from the agent dir, which is a missing ' +
			'artifact rather than a cost of zero.',
	);
	return `${lines.join('\n')}\n`;
}
