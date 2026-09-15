import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
	CompositionRuleId,
	S4CompositionAction,
	S4CompositionObservation,
	S4DecisionSource,
	S4DirectionCounts,
	S4GuardrailStatus,
	S4Lifecycle,
	S4Quality,
	S4QualitySignals,
	S4Preflight,
	TelemetryRecord,
} from '../src/types.ts';

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

export interface ProducerInvocation {
	/** Stable producer-side identity used to ignore a duplicated stream line. */
	recordId?: string;
	at?: number;
	commandId?: string;
	flowId?: string;
	delegationId?: string;
	role?: string;
	ref?: string;
	stateDigest?: string;
	decision?: string;
	errorClass?: string;
	/** Bounded producer lookup-outcome classification, when the record carries it. */
	lookupOutcome?: string;
	stateDrift?: boolean;
	concurrentExecutions?: number;
	mutating?: boolean;
	forced?: boolean;
	lookup?: boolean;
	executed: boolean;
	lookupFailed: boolean;
}

const PRODUCER_INVOCATION_ENV = [
	'BASH_TOOLS_INVOCATIONS_PATH',
	'BASH_TOOLS_INVOCATION_STREAM',
	'BASH_TOOLS_TELEMETRY_PATH',
];

function producerInvocationFiles(agentDir: string): string[] {
	const configured = PRODUCER_INVOCATION_ENV.map((name) => process.env[name]).filter(
		(value): value is string => Boolean(value),
	);
	return [
		...configured,
		join(agentDir, 'bash-tools', 'invocations.jsonl'),
		join(agentDir, 'bash-tools', 'verify-invocations.jsonl'),
		join(agentDir, 'bash-tools-invocations.jsonl'),
		join(agentDir, 'bash-tools-invocation-stream.jsonl'),
	].filter((file, index, all) => all.indexOf(file) === index);
}

export function resolveProducerInvocationPath(
	agentDir: string,
	filePath?: string,
): string | undefined {
	const file =
		filePath ?? producerInvocationFiles(agentDir).find((candidate) => existsSync(candidate));
	return file && existsSync(file) ? file : undefined;
}

function firstString(...values: unknown[]): string | undefined {
	return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function invocationStateDigest(value: unknown): string | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const state = value as Record<string, unknown>;
	const nested = state.repositoryState ?? state.repository_state;
	if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
		const digest =
			(nested as Record<string, unknown>).dirtyFilesDigest ??
			(nested as Record<string, unknown>).dirty_digest;
		if (typeof digest === 'string') return digest.slice(0, 12);
	}
	const digest = state.stateDigest ?? state.state_digest ?? state.dirtyFilesDigest;
	return typeof digest === 'string' ? digest.slice(0, 12) : undefined;
}

function producerInvocationOf(
	record: unknown,
	validationOnly = true,
): ProducerInvocation | undefined {
	if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined;
	const raw = record as Record<string, unknown>;
	const payload =
		raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload)
			? (raw.payload as Record<string, unknown>)
			: raw;
	const decision =
		typeof raw.decision === 'string'
			? raw.decision
			: typeof payload.decision === 'string'
				? payload.decision
				: undefined;
	const decisionLower = decision?.toLowerCase().replaceAll('_', '-');
	const lookupValue = raw.lookup ?? payload.lookup;
	const lookupDetails =
		lookupValue && typeof lookupValue === 'object' && !Array.isArray(lookupValue)
			? (lookupValue as Record<string, unknown>)
			: undefined;
	const lookup =
		(typeof lookupValue === 'boolean' ? lookupValue : undefined) ??
		(lookupDetails?.attempted === true ? true : undefined) ??
		(['lookup', 'resolved', 'not-found'].includes(decisionLower ?? '') ? true : undefined);
	const failedDecision = ['error', 'failed', 'not-found', 'denied', 'timeout'].includes(
		decisionLower ?? '',
	);
	const lookupFailed =
		raw.lookupFailed === true ||
		payload.lookupFailed === true ||
		lookupDetails?.success === false ||
		(lookup === true && failedDecision);
	const executed =
		typeof raw.executed === 'boolean'
			? raw.executed
			: typeof payload.executed === 'boolean'
				? payload.executed
				: raw.reused === true ||
					  payload.reused === true ||
					  decisionLower === 'hit' ||
					  decisionLower === 'lookup' ||
					  decisionLower === 'resolved' ||
					  failedDecision
					? false
					: !lookupFailed;
	const toolName = raw.toolName ?? raw.tool ?? payload.toolName ?? payload.tool;
	const commandIdValue = raw.commandId ?? payload.commandId;
	const commandId = typeof commandIdValue === 'string' ? commandIdValue : undefined;
	if (validationOnly && toolName !== undefined && toolName !== 'verify') return undefined;
	if (validationOnly && commandId !== undefined && commandId !== 'verify') return undefined;
	if (!validationOnly && commandId === undefined && toolName === undefined) return undefined;
	const ref = [raw.ref, payload.ref].find(
		(candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
	);
	const flowId = [raw.flowId, payload.flowId].find(
		(candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
	);
	const delegationId = [raw.delegationId, payload.delegationId].find(
		(candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
	);
	const role = [raw.role, payload.role].find(
		(candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
	);
	const explicitErrorClass = [raw.errorClass, payload.errorClass].find(
		(candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
	);
	const errorClass =
		explicitErrorClass ??
		(['denied', 'timeout', 'not-found'].includes(decisionLower ?? '') ? decisionLower : undefined);
	const execution =
		raw.execution && typeof raw.execution === 'object' && !Array.isArray(raw.execution)
			? (raw.execution as Record<string, unknown>)
			: payload.execution &&
				  typeof payload.execution === 'object' &&
				  !Array.isArray(payload.execution)
				? (payload.execution as Record<string, unknown>)
				: {};
	const booleanField = (name: string): boolean | undefined => {
		const value = raw[name] ?? payload[name] ?? execution[name];
		if (typeof value === 'boolean') return value;
		if (name === 'forced' && decisionLower === 'forced') return true;
		return undefined;
	};
	const numberField = (name: string): number | undefined => {
		const value = raw[name] ?? payload[name] ?? execution[name];
		return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
	};
	const sessionId = firstString(raw.sessionId, payload.sessionId);
	const toolCallId = firstString(raw.toolCallId, payload.toolCallId);
	const recordId =
		firstString(
			raw.invocationId,
			payload.invocationId,
			raw.recordId,
			payload.recordId,
			raw.id,
			payload.id,
		) ?? (sessionId && toolCallId ? `${sessionId}:${toolCallId}` : undefined);
	const atValue = raw.at ?? payload.at ?? raw.timestamp ?? payload.timestamp;
	const at =
		typeof atValue === 'number' && Number.isFinite(atValue)
			? atValue
			: typeof atValue === 'string'
				? Number.isFinite(Number(atValue))
					? Number(atValue)
					: Number.isFinite(Date.parse(atValue))
						? Date.parse(atValue)
						: undefined
				: undefined;
	return {
		...(recordId === undefined ? {} : { recordId }),
		...(at === undefined ? {} : { at }),
		...(commandId ? { commandId } : {}),
		...(flowId ? { flowId } : {}),
		...(delegationId ? { delegationId } : {}),
		...(role ? { role } : {}),
		...(ref ? { ref } : {}),
		...((invocationStateDigest(raw) ?? invocationStateDigest(payload))
			? { stateDigest: invocationStateDigest(raw) ?? invocationStateDigest(payload) }
			: {}),
		...(decision ? { decision } : {}),
		...(errorClass ? { errorClass } : {}),
		...(lookupOutcomeOfRecord(raw, payload) === undefined
			? {}
			: { lookupOutcome: lookupOutcomeOfRecord(raw, payload) }),
		...(booleanField('stateDrift') === undefined ? {} : { stateDrift: booleanField('stateDrift') }),
		...(numberField('concurrentExecutions') === undefined
			? {}
			: { concurrentExecutions: numberField('concurrentExecutions') }),
		...(booleanField('mutating') === undefined ? {} : { mutating: booleanField('mutating') }),
		...(booleanField('forced') === undefined ? {} : { forced: booleanField('forced') }),
		...(lookup === undefined ? {} : { lookup }),
		executed,
		lookupFailed,
	};
}

const LOOKUP_OUTCOME_VALUES = new Set(['success', 'not-found', 'unauthorized-flow', 'corrupt']);

function lookupOutcomeOfRecord(
	raw: Record<string, unknown>,
	payload: Record<string, unknown>,
): string | undefined {
	const block =
		raw.lookup && typeof raw.lookup === 'object' && !Array.isArray(raw.lookup)
			? (raw.lookup as Record<string, unknown>)
			: payload.lookup && typeof payload.lookup === 'object' && !Array.isArray(payload.lookup)
				? (payload.lookup as Record<string, unknown>)
				: undefined;
	const value = block && typeof block.outcome === 'string' ? block.outcome : undefined;
	return value && LOOKUP_OUTCOME_VALUES.has(value) ? value : undefined;
}

function readProducerRecords(
	agentDir: string,
	filePath: string | undefined,
	validationOnly: boolean,
): ProducerInvocation[] {
	const file = resolveProducerInvocationPath(agentDir, filePath);
	if (!file) return [];
	let contents: string;
	try {
		contents = readFileSync(file, 'utf8');
	} catch {
		return [];
	}
	const records: ProducerInvocation[] = [];
	const seenRecordIds = new Set<string>();
	for (const line of contents.split('\n')) {
		if (!line.trim()) continue;
		try {
			const invocation = producerInvocationOf(JSON.parse(line), validationOnly);
			if (!invocation) continue;
			if (invocation.recordId) {
				if (seenRecordIds.has(invocation.recordId)) continue;
				seenRecordIds.add(invocation.recordId);
			}
			records.push(invocation);
		} catch {
			// Ignore torn invocation records just as telemetry ignores torn lines.
		}
	}
	return records;
}

export function readProducerInvocations(agentDir: string, filePath?: string): ProducerInvocation[] {
	return readProducerRecords(agentDir, filePath, true);
}

/** Reads all producer command records for repository-state diagnostics, not only verify calls. */
export function readProducerExecutionInvocations(
	agentDir: string,
	filePath?: string,
): ProducerInvocation[] {
	return readProducerRecords(agentDir, filePath, false);
}

function producerInvocationsInTelemetryWindow(
	invocations: ProducerInvocation[],
	records: TelemetryRecord[],
): ProducerInvocation[] {
	const timestamps = records.map((record) => record.at).filter(Number.isFinite);
	if (!timestamps.length) return invocations;
	const from = Math.min(...timestamps);
	const to = Math.max(...timestamps);
	return invocations.filter(
		(invocation) => invocation.at === undefined || (invocation.at >= from && invocation.at <= to),
	);
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
	/** Failed lookups, kept distinct from a flow that simply had no refs to reuse. */
	lookupFailures: number;
	lookupFailureClasses: Record<string, number>;
	/** Bounded producer lookup-outcome distribution across observed refs and failures. */
	lookupOutcomes: Record<string, number>;
	/** read_batch evidence refs minted into the flow and reused unchanged. */
	readRefsMinted: number;
	readRefsReused: number;
	/** read_batch ref lookups that resolved existing evidence. */
	readRefsResolvedByLookup: number;
	/** Codegraph results that carried a producer index-state block, with distinct index ids. */
	codegraphIndexResults: number;
	codegraphIndexIds: number;
	/** Successful reuse divided by all successful and failed evidence attempts. */
	reuseRate: number | null;
	producerInvocations: number;
	producerExecutions: number;
	stateDriftExecutions: number;
	maxConcurrentExecutions: number;
	mutatingCommands: number;
	forcedExecutions: number;
	lockContentionRefusals: number;
}

export interface CompositionMeasurement {
	events: number;
	warnings: number;
	refusals: number;
	byRule: Record<string, number>;
	byPolicy: Record<string, number>;
	byOverride: Record<string, number>;
}

export interface Measurement {
	agentDir: string;
	windowFrom: number;
	windowTo: number;
	rootSessions: number;
	childSessions: number;
	telemetryRecords: number;
	cutoff: number;
	producerInvocationStream: { available: boolean; records: number; path?: string };
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
	composition: CompositionMeasurement;
	validation: {
		overall: ValidationEvidence;
		byRole: ValidationEvidence[];
		byFlow: ValidationEvidence[];
	};
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
	/** Number of ordinary child delegation records, excluding typed composition boundary events. */
	ordinaryDelegationRecords: number;
	/** Sum of child spend from telemetry. Root spend is not in telemetry and stays analyzer-side. */
	childrenCost: number;
}

function tokensOf(list: DeliveredResult[]): number[] {
	return list.map((r) => r.tokens);
}

function carryOf(list: DeliveredResult[]): number {
	return list.reduce((acc, r) => acc + r.carryTokens, 0);
}

function isS4Record(record: TelemetryRecord): boolean {
	return (
		record.event === 's4_preflight' ||
		record.s4Preflight !== undefined ||
		record.s4Outcome !== undefined
	);
}

function isCompositionRecord(record: TelemetryRecord): boolean {
	return (
		!isS4Record(record) &&
		(record.event === 'composition' || record.compositionVerdict !== undefined)
	);
}

function tallyComposition(records: TelemetryRecord[], cutoff: number): CompositionMeasurement {
	const byRule: Record<string, number> = {};
	const byPolicy: Record<string, number> = {};
	const byOverride: Record<string, number> = {};
	let warnings = 0;
	let refusals = 0;
	const compositionFrom = Number.isFinite(cutoff) ? cutoff : Number.NEGATIVE_INFINITY;
	for (const record of records.filter(
		(candidate) => isCompositionRecord(candidate) && candidate.at >= compositionFrom,
	)) {
		const verdict = record.compositionVerdict;
		if (!verdict) continue;
		if (verdict.action === 'warn') warnings++;
		if (verdict.action === 'refuse') refusals++;
		byRule[verdict.rule] = (byRule[verdict.rule] ?? 0) + 1;
		byPolicy[verdict.policy] = (byPolicy[verdict.policy] ?? 0) + 1;
		const override = record.compositionPolicyOverride ?? 'none';
		byOverride[override] = (byOverride[override] ?? 0) + 1;
	}
	return {
		events: warnings + refusals,
		warnings,
		refusals,
		byRule,
		byPolicy,
		byOverride,
	};
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
 * Tally validation evidence for one role, flow, or the complete sample. Producer invocation records
 * refine execution and digest counts when the producer stream is available; extension telemetry remains
 * the fallback so historical fixtures and partial installations stay measurable.
 */
function tallyValidation(
	records: TelemetryRecord[],
	scope: string,
	producerInvocations: ProducerInvocation[] = [],
	producerExecutionInvocations: ProducerInvocation[] = producerInvocations,
): ValidationEvidence {
	const digests = new Map<string, Set<string>>();
	const executedInFlow = new Map<string, number>();
	const consumerDigestByRef = new Map<string, string>();
	let delegations = 0;
	let delegationsWithRefs = 0;
	let refsMinted = 0;
	let refsExecuted = 0;
	let refsReused = 0;
	let refsResolvedByLookup = 0;
	let fullValidationPasses = 0;
	let lookupFailures = 0;
	let lookupFailureClasses: Record<string, number> = {};
	const lookupOutcomes: Record<string, number> = {};
	let readRefsMinted = 0;
	let readRefsReused = 0;
	let readRefsResolvedByLookup = 0;
	let codegraphIndexResults = 0;
	const codegraphIndexIds = new Set<string>();
	let stateDriftExecutions = 0;
	let maxConcurrentExecutions = 0;
	let mutatingCommands = 0;
	let forcedExecutions = 0;
	let lockContentionRefusals = 0;
	let successfulReuse = 0;
	let evidenceAttempts = 0;
	for (const record of records) {
		delegations++;
		fullValidationPasses += record.metrics?.fullValidationPasses ?? 0;
		lockContentionRefusals += record.budget?.repositoryWriteLockRefusals ?? 0;
		const refs = record.metrics?.validationRefs ?? [];
		const failures = record.metrics?.lookupFailures ?? [];
		if (refs.length) delegationsWithRefs++;
		const flow = record.flowId ?? '-';
		for (const ref of refs) {
			evidenceAttempts++;
			if (ref.lookup) {
				refsResolvedByLookup++;
				successfulReuse++;
				continue;
			}
			refsMinted++;
			if (ref.reused) {
				refsReused++;
				successfulReuse++;
			} else refsExecuted++;
			const digestsHere = digests.get(flow) ?? new Set<string>();
			digests.set(flow, digestsHere);
			executedInFlow.set(flow, (executedInFlow.get(flow) ?? 0) + (ref.reused ? 0 : 1));
			if (ref.stateDigest) {
				digestsHere.add(ref.stateDigest);
				consumerDigestByRef.set(`${flow}:${ref.ref}`, ref.stateDigest);
			}
		}
		for (const failure of failures) {
			lookupFailures++;
			lookupFailureClasses[failure.errorClass] =
				(lookupFailureClasses[failure.errorClass] ?? 0) + 1;
			if (failure.lookupOutcome)
				lookupOutcomes[failure.lookupOutcome] = (lookupOutcomes[failure.lookupOutcome] ?? 0) + 1;
			evidenceAttempts++;
		}
		for (const ref of refs) {
			if (ref.lookupOutcome)
				lookupOutcomes[ref.lookupOutcome] = (lookupOutcomes[ref.lookupOutcome] ?? 0) + 1;
		}
		for (const readRef of record.metrics?.readRefs ?? []) {
			if (readRef.lookup) readRefsResolvedByLookup++;
			else if (readRef.reused) readRefsReused++;
			else readRefsMinted++;
		}
		const indexState = record.metrics?.codegraphIndex;
		if (indexState) {
			codegraphIndexResults += indexState.results;
			for (const id of indexState.indexIds) codegraphIndexIds.add(id);
		}
		for (const execution of record.metrics?.validationExecutions ?? []) {
			if (execution.stateDrift) stateDriftExecutions++;
			if (execution.concurrentExecutions !== undefined)
				maxConcurrentExecutions = Math.max(maxConcurrentExecutions, execution.concurrentExecutions);
			if (execution.mutating) mutatingCommands++;
			if (execution.forced) forcedExecutions++;
		}
	}

	const scopedInvocations = producerInvocations.filter((invocation) => {
		if (scope === 'overall') return true;
		if (scope.startsWith('flow:')) return (invocation.flowId ?? '-') === scope.slice(5);
		return invocation.role === scope;
	});
	const scopedExecutionInvocations = producerExecutionInvocations.filter((invocation) => {
		if (scope === 'overall') return true;
		if (scope.startsWith('flow:')) return (invocation.flowId ?? '-') === scope.slice(5);
		return invocation.role === scope;
	});
	const producerHasStateDrift = scopedExecutionInvocations.some(
		(invocation) => invocation.stateDrift !== undefined,
	);
	const producerHasConcurrency = scopedExecutionInvocations.some(
		(invocation) => invocation.concurrentExecutions !== undefined,
	);
	const producerHasMutating = scopedExecutionInvocations.some(
		(invocation) => invocation.mutating !== undefined,
	);
	const producerHasForced = scopedExecutionInvocations.some(
		(invocation) => invocation.forced !== undefined,
	);
	if (producerHasStateDrift) stateDriftExecutions = 0;
	if (producerHasConcurrency) maxConcurrentExecutions = 0;
	if (producerHasMutating) mutatingCommands = 0;
	if (producerHasForced) forcedExecutions = 0;
	let producerExecutions = 0;
	for (const invocation of scopedExecutionInvocations) {
		if (invocation.stateDrift && invocation.executed) stateDriftExecutions++;
		if (invocation.concurrentExecutions !== undefined)
			maxConcurrentExecutions = Math.max(maxConcurrentExecutions, invocation.concurrentExecutions);
		if (invocation.mutating && invocation.executed) mutatingCommands++;
		if (invocation.forced && invocation.executed) forcedExecutions++;
	}
	for (const invocation of scopedInvocations) {
		const flow = invocation.flowId ?? '-';
		const digest =
			invocation.stateDigest ??
			(invocation.ref ? consumerDigestByRef.get(`${flow}:${invocation.ref}`) : undefined);
		if (digest) {
			const digestsHere = digests.get(flow) ?? new Set<string>();
			digests.set(flow, digestsHere);
			digestsHere.add(digest);
		}
		if (invocation.lookupFailed) {
			lookupFailures++;
			lookupFailureClasses[invocation.decision ?? 'unknown'] =
				(lookupFailureClasses[invocation.decision ?? 'unknown'] ?? 0) + 1;
			evidenceAttempts++;
		}
		if (invocation.executed) {
			producerExecutions++;
			executedInFlow.set(flow, (executedInFlow.get(flow) ?? 0) + 1);
		}
	}
	if (scopedInvocations.length > 0) {
		// The producer stream is one record per invocation and is authoritative for attempts, reuse, and execution.
		const producerDigests = new Map<string, Set<string>>();
		for (const invocation of scopedInvocations) {
			const flow = invocation.flowId ?? '-';
			const digest =
				invocation.stateDigest ??
				(invocation.ref ? consumerDigestByRef.get(`${flow}:${invocation.ref}`) : undefined);
			if (!digest) continue;
			const digestsHere = producerDigests.get(flow) ?? new Set<string>();
			digestsHere.add(digest);
			producerDigests.set(flow, digestsHere);
		}
		if (producerDigests.size > 0) {
			digests.clear();
			for (const [flow, flowDigests] of producerDigests) digests.set(flow, flowDigests);
		}
		const successfulInvocations = scopedInvocations.filter(
			(invocation) => !invocation.lookupFailed,
		);
		evidenceAttempts = scopedInvocations.length;
		successfulReuse = successfulInvocations.filter((invocation) => !invocation.executed).length;
		refsMinted = successfulInvocations.filter(
			(invocation) => Boolean(invocation.ref) && invocation.lookup !== true,
		).length;
		refsExecuted = successfulInvocations.filter(
			(invocation) => Boolean(invocation.ref) && invocation.executed,
		).length;
		refsReused = successfulInvocations.filter(
			(invocation) => Boolean(invocation.ref) && !invocation.executed && invocation.lookup !== true,
		).length;
		refsResolvedByLookup = successfulInvocations.filter(
			(invocation) => Boolean(invocation.ref) && invocation.lookup === true,
		).length;
		lookupFailures = scopedInvocations.filter((invocation) => invocation.lookupFailed).length;
		lookupFailureClasses = {};
		for (const invocation of scopedInvocations.filter((item) => item.lookupFailed)) {
			const key = invocation.errorClass ?? 'unknown';
			lookupFailureClasses[key] = (lookupFailureClasses[key] ?? 0) + 1;
		}
		for (const flow of new Set(scopedInvocations.map((invocation) => invocation.flowId ?? '-')))
			executedInFlow.set(
				flow,
				scopedInvocations.filter(
					(invocation) => (invocation.flowId ?? '-') === flow && invocation.executed,
				).length,
			);
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
		lookupFailures,
		lookupFailureClasses,
		lookupOutcomes,
		readRefsMinted,
		readRefsReused,
		readRefsResolvedByLookup,
		codegraphIndexResults,
		codegraphIndexIds: codegraphIndexIds.size,
		reuseRate: evidenceAttempts ? Number((successfulReuse / evidenceAttempts).toFixed(2)) : null,
		producerInvocations: scopedInvocations.length,
		producerExecutions,
		stateDriftExecutions,
		maxConcurrentExecutions,
		mutatingCommands,
		forcedExecutions,
		lockContentionRefusals,
	};
}

export function measure(
	agentDir: string,
	cutoff = defaultCutoff(readTelemetry(agentDir)),
	producerInvocationPath?: string,
): Measurement {
	const records = readTelemetry(agentDir);
	// S4 preflight and nested outcome records are additive evidence, never ordinary
	// delegation turns. Composition events remain counted by tallyComposition.
	const delegationRecords = records.filter(
		(record) => !isCompositionRecord(record) && !isS4Record(record),
	);
	const producerStreamPath = resolveProducerInvocationPath(agentDir, producerInvocationPath);
	const producerInvocations = producerInvocationsInTelemetryWindow(
		readProducerInvocations(agentDir, producerStreamPath),
		records,
	);
	const producerExecutionInvocations = producerInvocationsInTelemetryWindow(
		readProducerExecutionInvocations(agentDir, producerStreamPath),
		records,
	);
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
		delegationRecords.map((r) => r.sessionFile).filter((f): f is string => Boolean(f)),
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

	const reportTurns = delegationRecords.filter((r) => r.report);
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
	for (const record of delegationRecords) {
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
		producerInvocationStream: {
			available: producerStreamPath !== undefined,
			records: producerInvocations.length,
			...(producerStreamPath ? { path: producerStreamPath } : {}),
		},
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
		composition: tallyComposition(records, cutoff),
		validation: {
			overall: tallyValidation(
				delegationRecords,
				'overall',
				producerInvocations,
				producerExecutionInvocations,
			),
			byRole: [...validationRoles.entries()]
				.map(([role, list]) =>
					tallyValidation(list, role, producerInvocations, producerExecutionInvocations),
				)
				.toSorted((a, b) => b.delegations - a.delegations || a.scope.localeCompare(b.scope)),
			byFlow: [
				...new Set([
					...delegationRecords.map((record) => record.flowId ?? '-'),
					...producerInvocations.map((invocation) => invocation.flowId ?? '-'),
					...producerExecutionInvocations.map((invocation) => invocation.flowId ?? '-'),
				]),
			]
				.map((flow) =>
					tallyValidation(
						delegationRecords.filter((record) => (record.flowId ?? '-') === flow),
						`flow:${flow}`,
						producerInvocations,
						producerExecutionInvocations,
					),
				)
				.toSorted((a, b) => a.scope.localeCompare(b.scope)),
		},
		byRole,
		childrenInTelemetryWindow: childrenInWindow,
		unattributedChildren,
		ordinaryDelegationRecords: delegationRecords.length,
		childrenCost: Number(
			delegationRecords.reduce((acc, r) => acc + (r.usage?.cost ?? 0), 0).toFixed(4),
		),
	};
}

export interface S4Policy {
	version: 1;
	minimumPreflights: number;
	minimumWindowMs: number;
	minimumEligibleObservationsPerRule: number;
	minimumIndependentReviews: number;
	maxUnknownRate: number;
	maxUnresolvedOrAbandonedRate: number;
	maxRegressionAfterReviewPassRate: number;
	maxEscalationRate: number;
	maxTier1DiscoveryFailureRate: number;
}

export type S4MachineStatus = 'ENFORCE_CANDIDATE' | 'RETAIN_WARN' | 'INSUFFICIENT_EVIDENCE';
export type S4LegacyDecision = 'pass' | 'fail' | 'incomplete';

export interface S4RuleStatistics {
	observed: number;
	eligible: number;
	ineligible: number;
	compliant: number;
	noncompliant: number;
	unknown: number;
	byAction: Record<S4CompositionAction, number>;
	byDecisionSource: Record<S4DecisionSource, number>;
	minimumDenominator: {
		required: number;
		eligible: number;
		status: 'pass' | 'fail' | 'insufficient' | 'disabled';
	};
	minimumDenominatorStatus: 'pass' | 'fail' | 'insufficient' | 'disabled';
}

export interface S4RateGuardrail {
	numerator: number;
	denominator: number;
	rate: number | null;
	threshold: number;
	status: S4GuardrailStatus;
	direction?: S4DirectionCounts;
	directionByTier?: Record<string, S4DirectionCounts>;
}

export interface S4AnalysisWindow {
	from?: number;
	to?: number;
	independentReview?: 'pass' | 'fail' | 'pending';
}

export interface S4DecisionArtifact {
	v: 1;
	status: S4MachineStatus;
	decision: S4LegacyDecision;
	policy: S4Policy;
	window: {
		from: number;
		to: number;
		durationMs: number;
		minimumMs: number;
		status: S4GuardrailStatus;
	};
	preflights: number;
	outcomes: number;
	boundaries: number;
	ruleStatistics: Record<CompositionRuleId, S4RuleStatistics>;
	guardrails: {
		unresolvedOrAbandoned: S4RateGuardrail;
		regressionAfterReviewPass: S4RateGuardrail;
		escalation: S4RateGuardrail;
		tier1DiscoveryFailure: S4RateGuardrail;
	};
	independentReview: {
		requested: 'pass' | 'fail' | 'pending';
		observedPasses: number;
		minimum: number;
		status: S4GuardrailStatus;
	};
	unknownRate: {
		numerator: number;
		denominator: number;
		rate: number | null;
		threshold: number;
		status: S4GuardrailStatus;
	};
	overrideRate: {
		numerator: number;
		denominator: number;
		rate: number | null;
		status: S4GuardrailStatus;
	};
	reasons: string[];
}

const S4_RULES: CompositionRuleId[] = ['R1', 'R2', 'R3', 'R4'];
const S4_ACTIONS = new Set<S4CompositionAction>([
	'not_applicable',
	'allow',
	'warn',
	'refuse',
	'disabled',
]);
const S4_SOURCES = new Set<S4DecisionSource>(['default', 'override']);
const S4_LIFECYCLES = new Set<S4Lifecycle>([
	'settled',
	'failed',
	'aborted',
	'blocked',
	'abandoned',
	'unknown',
]);
const S4_QUALITY = new Set<S4Quality>(['pass', 'fail', 'incomplete', 'not_run', 'unknown']);

function loadS4Policy(): { policy: S4Policy; valid: boolean } {
	try {
		const parsed = JSON.parse(
			readFileSync(new URL('./s4-policy.json', import.meta.url), 'utf8'),
		) as Partial<S4Policy>;
		const keys: (keyof S4Policy)[] = [
			'minimumPreflights',
			'minimumWindowMs',
			'minimumEligibleObservationsPerRule',
			'minimumIndependentReviews',
			'maxUnknownRate',
			'maxUnresolvedOrAbandonedRate',
			'maxRegressionAfterReviewPassRate',
			'maxEscalationRate',
			'maxTier1DiscoveryFailureRate',
		];
		const valid =
			parsed.version === 1 &&
			keys.every(
				(key) =>
					typeof parsed[key] === 'number' && Number.isFinite(parsed[key]) && parsed[key] >= 0,
			);
		return { policy: parsed as S4Policy, valid };
	} catch {
		return { policy: {} as S4Policy, valid: false };
	}
}

function blankRuleStats(): S4RuleStatistics {
	return {
		observed: 0,
		eligible: 0,
		ineligible: 0,
		compliant: 0,
		noncompliant: 0,
		unknown: 0,
		byAction: { not_applicable: 0, allow: 0, warn: 0, refuse: 0, disabled: 0 },
		byDecisionSource: { default: 0, override: 0 },
		minimumDenominator: { required: 0, eligible: 0, status: 'insufficient' },
		minimumDenominatorStatus: 'insufficient',
	};
}

function finiteTimestamp(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function validS4Preflight(
	record: TelemetryRecord,
): record is TelemetryRecord & { s4Preflight: S4Preflight } {
	const preflight = record.s4Preflight;
	if (
		!preflight ||
		record.event !== 's4_preflight' ||
		preflight.v !== 1 ||
		!preflight.compositionBoundaryId ||
		!record.flowId ||
		!record.taskId
	)
		return false;
	if (
		!['single', 'parallel', 'chain'].includes(preflight.mode) ||
		!['warn', 'enforce', 'off'].includes(preflight.policy)
	)
		return false;
	if (
		preflight.policyOverride !== undefined &&
		!['warn', 'enforce', 'off'].includes(preflight.policyOverride)
	)
		return false;
	if (
		!Number.isSafeInteger(preflight.expectedChildCount) ||
		preflight.expectedChildCount < 0 ||
		!Array.isArray(preflight.observations) ||
		preflight.observations.length < S4_RULES.length
	)
		return false;
	const byRule = new Map<CompositionRuleId, S4CompositionObservation[]>();
	for (const observation of preflight.observations) {
		if (
			!observation ||
			!S4_RULES.includes(observation.ruleId) ||
			!S4_ACTIONS.has(observation.action) ||
			!S4_SOURCES.has(observation.decisionSource) ||
			typeof observation.eligible !== 'boolean' ||
			(observation.compliant !== null && typeof observation.compliant !== 'boolean') ||
			!observation.reason ||
			observation.compositionBoundaryId !== preflight.compositionBoundaryId ||
			observation.mode !== preflight.mode ||
			observation.policy !== preflight.policy ||
			observation.expectedChildCount !== preflight.expectedChildCount
		)
			return false;
		if (
			observation.ruleId === 'R2' &&
			observation.eligible &&
			(preflight.mode !== 'parallel' || preflight.expectedChildCount <= 1)
		)
			return false;
		const list = byRule.get(observation.ruleId) ?? [];
		list.push(observation);
		byRule.set(observation.ruleId, list);
	}
	if (byRule.size !== S4_RULES.length) return false;
	for (const rule of S4_RULES) {
		const list = byRule.get(rule)!;
		if (
			!list.some((observation) => observation.eligible) &&
			(list.length !== 1 || list[0].action !== 'not_applicable' || list[0].compliant !== null)
		)
			return false;
		if (
			list.some((observation) => !observation.eligible && observation.action !== 'not_applicable')
		)
			return false;
	}
	return record.compositionBoundaryId === preflight.compositionBoundaryId;
}

function validS4Outcome(record: TelemetryRecord): boolean {
	const outcome = record.s4Outcome;
	if (
		!outcome ||
		(record.event !== undefined && record.event !== 's4_outcome') ||
		outcome.v !== 1 ||
		!S4_LIFECYCLES.has(outcome.lifecycle) ||
		!S4_QUALITY.has(outcome.quality) ||
		!S4_QUALITY.has(outcome.validationStatus) ||
		!S4_QUALITY.has(outcome.reviewStatus) ||
		!S4_QUALITY.has(outcome.budgetStatus)
	)
		return false;
	const correlation = outcome.correlation;
	if (
		!correlation ||
		!correlation.flowId ||
		!correlation.taskId ||
		!correlation.delegationId ||
		!correlation.compositionBoundaryId ||
		!Number.isSafeInteger(correlation.ledgerRevision) ||
		correlation.ledgerRevision <= 0
	)
		return false;
	if (
		record.flowId !== correlation.flowId ||
		record.taskId !== correlation.taskId ||
		record.delegationId !== correlation.delegationId ||
		record.ledgerRevision !== correlation.ledgerRevision ||
		record.compositionBoundaryId !== correlation.compositionBoundaryId
	)
		return false;
	if (correlation.tier !== undefined && record.tier !== correlation.tier) return false;
	if (
		!outcome.qualitySignals ||
		outcome.qualitySignals.componentStatusConsistent !== true ||
		typeof outcome.qualitySignals.unresolvedOrAbandoned !== 'boolean'
	)
		return false;
	if (record.role === 'reviewer' && typeof outcome.qualitySignals.reviewerPass !== 'boolean')
		return false;
	if (!['pass', 'fail', 'pending', 'unknown'].includes(outcome.independentReviewStatus))
		return false;
	if (
		outcome.quality === 'pass' &&
		(outcome.lifecycle !== 'settled' ||
			[outcome.validationStatus, outcome.reviewStatus, outcome.budgetStatus].some((status) =>
				['fail', 'incomplete', 'unknown'].includes(status),
			) ||
			outcome.qualitySignals?.unresolvedOrAbandoned === true)
	)
		return false;
	return true;
}

function s4DecisionWindow(
	records: TelemetryRecord[],
	requested?: S4AnalysisWindow,
): { window?: { from: number; to: number }; error?: string } {
	const hasFrom = requested?.from !== undefined;
	const hasTo = requested?.to !== undefined;
	if (hasFrom !== hasTo) return { error: 'explicit S4 windows require both from and to' };
	if (hasFrom || hasTo) {
		if (
			!finiteTimestamp(requested?.from) ||
			!finiteTimestamp(requested?.to) ||
			(requested!.from as number) > (requested!.to as number)
		)
			return { error: 'S4 window must be finite and inclusive with from <= to' };
		return { window: { from: requested!.from!, to: requested!.to! } };
	}
	const timestamps = records.map((record) => record.at).filter(finiteTimestamp);
	if (!timestamps.length) return { error: 'no observed S4 telemetry window' };
	return { window: { from: Math.min(...timestamps), to: Math.max(...timestamps) } };
}

function s4Bool(record: TelemetryRecord, key: keyof S4QualitySignals): boolean | null {
	const value = record.s4Outcome?.qualitySignals?.[key];
	return typeof value === 'boolean' ? value : null;
}

function s4Rate(
	numerator: number,
	denominator: number,
	threshold: number,
	unknown = false,
	emptyPass = false,
	direction?: S4DirectionCounts,
	directionByTier?: Record<string, S4DirectionCounts>,
): S4RateGuardrail {
	const rate = denominator > 0 ? numerator / denominator : emptyPass ? 0 : null;
	const status: S4GuardrailStatus = unknown
		? 'unknown'
		: rate === null
			? 'insufficient'
			: rate <= threshold
				? 'pass'
				: 'fail';
	return {
		numerator,
		denominator,
		rate,
		threshold,
		status,
		...(direction ? { direction } : {}),
		...(directionByTier ? { directionByTier } : {}),
	};
}

/** Strict S4 gate analysis. It treats malformed, missing, unknown, and uncorrelated evidence as denial. */
export function analyzeS4(
	records: TelemetryRecord[],
	requested: S4AnalysisWindow = {},
): S4DecisionArtifact {
	const loaded = loadS4Policy();
	const policy = loaded.policy;
	const reasons: string[] = loaded.valid ? [] : ['invalid S4 policy artifact'];
	const selected = records.filter(
		(record) =>
			record.event === 's4_preflight' ||
			record.s4Preflight !== undefined ||
			record.s4Outcome !== undefined ||
			record.event === 's4_outcome',
	);
	const resolved = s4DecisionWindow(selected, requested);
	if (resolved.error) reasons.push(resolved.error);
	const window = resolved.window ?? { from: 0, to: 0 };
	const inWindow = selected.filter(
		(record) => finiteTimestamp(record.at) && record.at >= window.from && record.at <= window.to,
	);
	const preflights = inWindow.filter(
		(record) => record.event === 's4_preflight' || record.s4Preflight !== undefined,
	);
	const outcomes = inWindow.filter(
		(record) => record.s4Outcome !== undefined || record.event === 's4_outcome',
	);
	const stats = Object.fromEntries(S4_RULES.map((rule) => [rule, blankRuleStats()])) as Record<
		CompositionRuleId,
		S4RuleStatistics
	>;
	const boundaries = new Map<
		string,
		{
			preflights: (TelemetryRecord & { s4Preflight: S4Preflight })[];
			outcomes: TelemetryRecord[];
			invalid: boolean;
		}
	>();
	let invalid = 0;
	for (const record of preflights) {
		const id = record.s4Preflight?.compositionBoundaryId ?? record.compositionBoundaryId ?? '';
		const entry = boundaries.get(id) ?? { preflights: [], outcomes: [], invalid: false };
		if (!validS4Preflight(record)) {
			entry.invalid = true;
			invalid++;
			reasons.push(`invalid S4 preflight or catalog coverage at boundary ${id || '(missing)'}`);
		} else {
			entry.preflights.push(record as TelemetryRecord & { s4Preflight: S4Preflight });
			for (const observation of record.s4Preflight.observations) {
				const rule = stats[observation.ruleId];
				rule.observed++;
				rule.byAction[observation.action]++;
				rule.byDecisionSource[observation.decisionSource]++;
				if (observation.eligible) {
					rule.eligible++;
					if (observation.compliant === true) rule.compliant++;
					else if (observation.compliant === false) rule.noncompliant++;
					else rule.unknown++;
				} else rule.ineligible++;
			}
		}
		if (entry.preflights.length > 1) {
			entry.invalid = true;
			invalid++;
			reasons.push(`duplicate S4 preflight boundary ${id || '(missing)'}`);
		}
		boundaries.set(id, entry);
	}
	for (const record of outcomes) {
		const id =
			record.s4Outcome?.correlation?.compositionBoundaryId ?? record.compositionBoundaryId ?? '';
		const entry = boundaries.get(id) ?? { preflights: [], outcomes: [], invalid: false };
		entry.outcomes.push(record);
		if (!validS4Outcome(record)) {
			entry.invalid = true;
			invalid++;
			reasons.push(`invalid or mismatched S4 outcome correlation at boundary ${id || '(missing)'}`);
		}
		if (record.s4Outcome?.correlation?.compositionBoundaryId !== record.compositionBoundaryId) {
			entry.invalid = true;
			invalid++;
			reasons.push(
				`outer and nested S4 outcome boundary IDs differ at boundary ${id || '(missing)'}`,
			);
		}
		boundaries.set(id, entry);
	}
	const seen = new Set<string>();
	for (const record of outcomes.filter(validS4Outcome)) {
		const outcome = record.s4Outcome!;
		const key = `${outcome.correlation.compositionBoundaryId}:${outcome.correlation.delegationId}`;
		if (seen.has(key)) {
			invalid++;
			reasons.push(`duplicate child delegation ID ${outcome.correlation.delegationId}`);
			boundaries.get(outcome.correlation.compositionBoundaryId)!.invalid = true;
		}
		seen.add(key);
	}
	for (const [id, entry] of boundaries) {
		if (!entry.preflights.length) {
			invalid++;
			reasons.push(`S4 outcomes have no matching preflight for boundary ${id || '(missing)'}`);
			continue;
		}
		const preflight = entry.preflights[0].s4Preflight;
		if (entry.outcomes.length !== preflight.expectedChildCount) {
			invalid++;
			entry.invalid = true;
			reasons.push(
				`S4 boundary ${id} expected ${preflight.expectedChildCount} outcomes but observed ${entry.outcomes.length}`,
			);
		}
		for (const outcomeRecord of entry.outcomes) {
			const outcome = outcomeRecord.s4Outcome;
			if (!outcome) continue;
			const owner = entry.preflights[0];
			if (
				(owner.flowId && outcomeRecord.flowId !== owner.flowId) ||
				(owner.taskId && outcomeRecord.taskId !== owner.taskId)
			) {
				invalid++;
				entry.invalid = true;
				reasons.push(`S4 outcome identity differs from its preflight at boundary ${id}`);
			}
		}
	}
	const validOutcomes = outcomes.filter(validS4Outcome).toSorted((a, b) => a.at - b.at);
	const byTask = new Map<string, TelemetryRecord[]>();
	for (const record of validOutcomes) {
		const key = `${record.flowId ?? ''}:${record.taskId ?? ''}`;
		byTask.set(key, [...(byTask.get(key) ?? []), record]);
	}
	const independentPasses = validOutcomes.filter(
		(record) =>
			record.s4Outcome!.independentReviewStatus === 'pass' ||
			record.s4Outcome!.qualitySignals.independentReviewStatus === 'pass',
	).length;
	let unresolved = 0;
	let unresolvedUnknown = 0;
	for (const record of validOutcomes) {
		const outcome = record.s4Outcome!;
		const signal = outcome.qualitySignals.unresolvedOrAbandoned;
		if (
			signal === true ||
			['failed', 'aborted', 'blocked', 'abandoned'].includes(outcome.lifecycle)
		)
			unresolved++;
		else if (signal !== false) unresolvedUnknown++;
	}
	let regressions = 0;
	let reviewPasses = 0;
	for (const list of byTask.values())
		for (let i = 0; i < list.length; i++) {
			const current = list[i].s4Outcome!;
			const reviewPass =
				current.independentReviewStatus === 'pass' ||
				current.qualitySignals?.reviewerPass === true ||
				(list[i].role === 'reviewer' && current.reviewStatus === 'pass');
			if (!reviewPass) continue;
			reviewPasses++;
			if (
				current.qualitySignals?.regressionAfterReviewPass === true ||
				list
					.slice(i + 1)
					.some(
						(later) =>
							later.s4Outcome!.quality !== 'pass' || later.s4Outcome!.lifecycle !== 'settled',
					)
			)
				regressions++;
		}
	let escalations = 0;
	let transitions = 0;
	const direction: S4DirectionCounts = { up: 0, down: 0, same: 0, unknown: 0 };
	const directionByTier: Record<string, S4DirectionCounts> = {};
	for (const list of byTask.values())
		for (let i = 1; i < list.length; i++) {
			const prior = list[i - 1];
			const current = list[i];
			const explicit = current.s4Outcome!.qualitySignals.escalation?.direction;
			const value =
				explicit ??
				(prior.tier !== undefined && current.tier !== undefined
					? current.tier > prior.tier
						? 'up'
						: current.tier < prior.tier
							? 'down'
							: 'same'
					: 'unknown');
			const tierKey = `${prior.tier ?? 'unknown'}->${current.tier ?? 'unknown'}`;
			const tierDirection =
				directionByTier[tierKey] ??
				(directionByTier[tierKey] = { up: 0, down: 0, same: 0, unknown: 0 });
			transitions++;
			direction[value]++;
			tierDirection[value]++;
			if (value === 'up') escalations++;
		}
	let tier1Failures = 0;
	let tier1Workers = 0;
	for (const record of validOutcomes)
		if (record.role === 'worker' && record.tier === 1) {
			tier1Workers++;
			const explicit = s4Bool(record, 'tier1DiscoveryFailure');
			if (
				explicit === true ||
				(explicit !== false &&
					!(byTask.get(`${record.flowId ?? ''}:${record.taskId ?? ''}`) ?? []).some(
						(prior) => prior.at < record.at && prior.role === 'scout',
					))
			)
				tier1Failures++;
		}
	for (const ruleId of S4_RULES) {
		const rule = stats[ruleId];
		const disabled = rule.eligible > 0 && rule.byAction.disabled === rule.eligible;
		const status = disabled
			? 'disabled'
			: rule.eligible < policy.minimumEligibleObservationsPerRule
				? 'insufficient'
				: rule.unknown > 0
					? 'insufficient'
					: rule.noncompliant > 0
						? 'fail'
						: 'pass';
		rule.minimumDenominator = {
			required: policy.minimumEligibleObservationsPerRule,
			eligible: rule.eligible,
			status,
		};
		rule.minimumDenominatorStatus = status;
	}
	const qualityFailure = validOutcomes.some((record) => record.s4Outcome!.quality === 'fail');
	const qualityIncomplete = validOutcomes.some((record) => record.s4Outcome!.quality !== 'pass');
	const unknownDenominator =
		validOutcomes.length + S4_RULES.reduce((sum, rule) => sum + stats[rule].eligible, 0);
	const unknownNumerator =
		invalid +
		unresolvedUnknown +
		S4_RULES.reduce((sum, rule) => sum + stats[rule].unknown, 0) +
		(qualityIncomplete ? 1 : 0);
	const unknownRate = s4Rate(unknownNumerator, unknownDenominator, policy.maxUnknownRate);
	const guardrails = {
		unresolvedOrAbandoned: s4Rate(
			unresolved,
			validOutcomes.length,
			policy.maxUnresolvedOrAbandonedRate,
			unresolvedUnknown > 0,
		),
		regressionAfterReviewPass: s4Rate(
			regressions,
			reviewPasses,
			policy.maxRegressionAfterReviewPassRate,
			false,
			true,
		),
		escalation: s4Rate(
			escalations,
			transitions,
			policy.maxEscalationRate,
			direction.unknown > 0,
			true,
			direction,
			directionByTier,
		),
		tier1DiscoveryFailure: s4Rate(
			tier1Failures,
			tier1Workers,
			policy.maxTier1DiscoveryFailureRate,
			false,
			true,
		),
	};
	const overrideNumerator = preflights.filter(
		(record) => record.s4Preflight?.policyOverride !== undefined,
	).length;
	const overrideRate = s4Rate(overrideNumerator, preflights.length, 0);
	const requestedReview = requested.independentReview ?? 'pending';
	const independentEvidencePasses = independentPasses + (requestedReview === 'pass' ? 1 : 0);
	const independentStatus: S4GuardrailStatus =
		independentEvidencePasses < policy.minimumIndependentReviews
			? 'insufficient'
			: requestedReview === 'pass'
				? 'pass'
				: requestedReview === 'pending'
					? 'unknown'
					: 'fail';
	if (preflights.length < policy.minimumPreflights)
		reasons.push(`minimum preflights not met (${preflights.length}/${policy.minimumPreflights})`);
	if (window.to - window.from < policy.minimumWindowMs)
		reasons.push(
			`minimum representative window not met (${window.to - window.from}/${policy.minimumWindowMs}ms)`,
		);
	if (
		preflights.some(
			(record) =>
				record.s4Preflight?.policy !== 'warn' || record.s4Preflight.policyOverride !== undefined,
		)
	)
		reasons.push('S4 evidence contains a non-default policy or override');
	if (independentEvidencePasses < policy.minimumIndependentReviews)
		reasons.push('minimum independent review passes not met');
	if (requestedReview !== 'pass') reasons.push(`independent review handoff is ${requestedReview}`);
	const policyMismatch = preflights.some(
		(record) =>
			record.s4Preflight?.policy !== 'warn' || record.s4Preflight.policyOverride !== undefined,
	);
	const guardrailFailure =
		qualityFailure || Object.values(guardrails).some((guardrail) => guardrail.status === 'fail');
	const insufficient =
		!loaded.valid ||
		Boolean(resolved.error) ||
		invalid > 0 ||
		policyMismatch ||
		qualityIncomplete ||
		preflights.length < policy.minimumPreflights ||
		window.to - window.from < policy.minimumWindowMs ||
		unknownRate.status !== 'pass' ||
		Object.values(guardrails).some(
			(guardrail) => guardrail.status === 'unknown' || guardrail.status === 'insufficient',
		) ||
		independentStatus === 'unknown' ||
		independentStatus === 'insufficient' ||
		overrideRate.status === 'insufficient';
	const ruleFailure = S4_RULES.some((rule) =>
		['fail', 'disabled'].includes(stats[rule].minimumDenominatorStatus),
	);
	const candidate =
		!insufficient &&
		!guardrailFailure &&
		!ruleFailure &&
		overrideNumerator === 0 &&
		requestedReview === 'pass' &&
		preflights.every(
			(record) =>
				record.s4Preflight?.policy === 'warn' && record.s4Preflight.policyOverride === undefined,
		);
	const status: S4MachineStatus = candidate
		? 'ENFORCE_CANDIDATE'
		: insufficient
			? 'INSUFFICIENT_EVIDENCE'
			: 'RETAIN_WARN';
	const decision: S4LegacyDecision = candidate
		? 'pass'
		: status === 'RETAIN_WARN'
			? 'fail'
			: 'incomplete';
	return {
		v: 1,
		status,
		decision,
		policy,
		window: {
			from: window.from,
			to: window.to,
			durationMs: window.to - window.from,
			minimumMs: policy.minimumWindowMs,
			status: window.to - window.from >= policy.minimumWindowMs ? 'pass' : 'insufficient',
		},
		preflights: preflights.length,
		outcomes: outcomes.length,
		boundaries: boundaries.size,
		ruleStatistics: stats,
		guardrails,
		independentReview: {
			requested: requestedReview,
			observedPasses: independentEvidencePasses,
			minimum: policy.minimumIndependentReviews,
			status: independentStatus,
		},
		unknownRate,
		overrideRate,
		reasons: [
			...new Set(
				reasons.concat(
					guardrailFailure ? ['one or more S4 guardrails exceeded its threshold'] : [],
					ruleFailure ? ['one or more rule denominators or compliance checks failed'] : [],
				),
			),
		],
	};
}

/** Legacy implementation retained only as a private compatibility reference. */
export function analyzeS4Legacy(records: TelemetryRecord[], requested?: S4AnalysisWindow): unknown {
	const selected = records.filter(
		(record) => record.event === 's4_preflight' || record.event === 's4_outcome',
	);
	const resolved = s4DecisionWindow(selected, requested);
	const reasons: string[] = [];
	if (resolved.error) reasons.push(resolved.error);
	const window = resolved.window ?? { from: 0, to: 0 };
	const inWindow = selected.filter((record) => record.at >= window.from && record.at <= window.to);
	const preflights = inWindow.filter((record) => record.event === 's4_preflight');
	const outcomes = inWindow.filter((record) => record.event === 's4_outcome');
	const byBoundary = new Map<
		string,
		{ preflight?: TelemetryRecord & { s4Preflight: S4Preflight }; outcomes: TelemetryRecord[] }
	>();
	for (const record of preflights) {
		const id = record.s4Preflight?.compositionBoundaryId ?? record.compositionBoundaryId ?? '';
		const entry = byBoundary.get(id) ?? { outcomes: [] };
		if (entry.preflight) reasons.push(`duplicate S4 preflight boundary ${id || '(missing)'}`);
		if (!validS4Preflight(record))
			reasons.push(`invalid S4 preflight boundary ${id || '(missing)'}`);
		else entry.preflight = record as TelemetryRecord & { s4Preflight: S4Preflight };
		byBoundary.set(id, entry);
	}
	for (const record of outcomes) {
		const id =
			record.s4Outcome?.correlation?.compositionBoundaryId ?? record.compositionBoundaryId ?? '';
		const entry = byBoundary.get(id) ?? { outcomes: [] };
		entry.outcomes.push(record);
		byBoundary.set(id, entry);
		const outcome = record.s4Outcome;
		if (
			record.event !== 's4_outcome' ||
			!outcome ||
			outcome.v !== 1 ||
			!S4_LIFECYCLES.has(outcome.lifecycle) ||
			!S4_QUALITY.has(outcome.quality) ||
			!S4_QUALITY.has(outcome.validationStatus) ||
			!S4_QUALITY.has(outcome.reviewStatus) ||
			!S4_QUALITY.has(outcome.budgetStatus) ||
			!outcome.correlation ||
			!outcome.correlation.flowId ||
			!outcome.correlation.taskId ||
			!outcome.correlation.delegationId ||
			!Number.isSafeInteger(outcome.correlation.ledgerRevision) ||
			outcome.correlation.ledgerRevision <= 0 ||
			!outcome.correlation.compositionBoundaryId
		)
			reasons.push(`invalid or incomplete S4 outcome correlation ${id || '(missing)'}`);
	}
	let hardFailure = false;
	for (const [boundary, entry] of byBoundary) {
		if (!entry.preflight) {
			reasons.push(`S4 outcome has no matching preflight for boundary ${boundary || '(missing)'}`);
			continue;
		}
		const preflight = entry.preflight.s4Preflight;
		for (const observation of preflight.observations) {
			const expected = !observation.eligible
				? preflight.policy === 'off'
					? 'disabled'
					: 'not_applicable'
				: observation.compliant === true
					? preflight.policy === 'off'
						? 'disabled'
						: 'allow'
					: preflight.policy === 'off'
						? 'disabled'
						: preflight.policy === 'enforce'
							? 'refuse'
							: 'warn';
			if (observation.action !== expected) {
				reasons.push(`S4 action mismatch ${observation.ruleId} at boundary ${boundary}`);
				hardFailure = true;
			}
			if (observation.eligible && observation.compliant === false) {
				reasons.push(
					`S4 composition rule ${observation.ruleId} is noncompliant at boundary ${boundary}`,
				);
				hardFailure = true;
			}
		}
		const expectedChildren = preflight.expectedChildCount;
		if (entry.outcomes.length !== expectedChildren) {
			reasons.push(
				`S4 boundary ${boundary} expected ${expectedChildren} outcomes but observed ${entry.outcomes.length}`,
			);
			continue;
		}
		for (const record of entry.outcomes) {
			const outcome = record.s4Outcome;
			if (!outcome || outcome.correlation.compositionBoundaryId !== boundary) continue;
			if (outcome.lifecycle !== 'settled') {
				reasons.push(`S4 child at boundary ${boundary} did not settle (${outcome.lifecycle})`);
				hardFailure = true;
			}
			if (outcome.quality === 'fail') {
				reasons.push(`S4 child at boundary ${boundary} failed quality checks`);
				hardFailure = true;
			} else if (outcome.quality !== 'pass') {
				reasons.push(
					`S4 child at boundary ${boundary} has non-passing quality (${outcome.quality})`,
				);
			}
		}
	}
	if (preflights.length === 0) reasons.push('no S4 preflight evidence in the requested window');
	const decision = hardFailure ? 'fail' : reasons.length ? 'incomplete' : 'pass';
	return {
		v: 1,
		decision,
		window,
		preflights: preflights.length,
		outcomes: outcomes.length,
		boundaries: byBoundary.size,
		reasons: [...new Set(reasons)],
	};
}

export function renderS4Markdown(decision: S4DecisionArtifact): string {
	const lines = [
		'# S4 automation decision',
		'',
		`- Status: **${decision.status}**`,
		`- Decision (legacy alias): **${decision.decision}**`,
		`- Window: ${new Date(decision.window.from).toISOString()} .. ${new Date(decision.window.to).toISOString()} (${decision.window.durationMs}ms)`,
		`- Preflights: ${decision.preflights}`,
		`- Outcomes: ${decision.outcomes}`,
		`- Boundaries: ${decision.boundaries}`,
		'',
		'## Rule statistics',
		'',
		'| Rule | Observed | Eligible | Ineligible | Compliant | Noncompliant | Unknown | Minimum denominator | Actions | Sources |',
		'| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |',
	];
	for (const rule of S4_RULES) {
		const stats = decision.ruleStatistics[rule];
		lines.push(
			`| ${rule} | ${stats.observed} | ${stats.eligible} | ${stats.ineligible} | ${stats.compliant} | ${stats.noncompliant} | ${stats.unknown} | ${stats.minimumDenominatorStatus} (${stats.eligible}/${stats.minimumDenominator.required}) | ${JSON.stringify(stats.byAction)} | ${JSON.stringify(stats.byDecisionSource)} |`,
		);
	}
	lines.push(
		'',
		'## Guardrails',
		'',
		...Object.entries(decision.guardrails).map(
			([name, guardrail]) =>
				`- ${name}: **${guardrail.status}** ${guardrail.numerator}/${guardrail.denominator} = ${guardrail.rate ?? 'unknown'} (threshold ${guardrail.threshold})`,
		),
		'',
		`- Unknown evidence: **${decision.unknownRate.status}** ${decision.unknownRate.numerator}/${decision.unknownRate.denominator}`,
		`- Independent review: **${decision.independentReview.status}** ${decision.independentReview.observedPasses}/${decision.independentReview.minimum}`,
		'',
		'## Reasons',
		'',
		...(decision.reasons.length ? decision.reasons.map((reason) => `- ${reason}`) : ['- none']),
		'',
	);
	return lines.join('\n');
}

function row(cells: (string | number)[]): string {
	return `| ${cells.join(' | ')} |`;
}

function formatCounts(values: Record<string, number>): string {
	return (
		Object.entries(values)
			.map(([key, value]) => `${key}:${value}`)
			.join(', ') || '-'
	);
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

const validationDiagnosticColumns = [
	'scope',
	'lookup failures',
	'failure classes',
	'reuse rate',
	'producer invocations',
	'producer executions',
	'state drift',
	'max concurrent',
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
		`Child spend recorded in telemetry: $${m.childrenCost.toFixed(4)} across ${m.ordinaryDelegationRecords} ordinary delegation turns.`,
	);
	lines.push('');
	lines.push('## Composition policy events');
	lines.push('');
	lines.push(
		`Typed composition events: ${m.composition.events} (${m.composition.warnings} warnings, ${m.composition.refusals} refusals).`,
	);
	lines.push(`By rule: ${formatCounts(m.composition.byRule)}.`);
	lines.push(`By policy: ${formatCounts(m.composition.byPolicy)}.`);
	lines.push(`By per-call override: ${formatCounts(m.composition.byOverride)}.`);
	lines.push(
		'Composition events are excluded from ordinary delegation, validation, and child-spend metrics.',
	);
	lines.push('');
	lines.push('## Validation evidence (the W7 target)');
	lines.push('');
	lines.push(
		'Per role, flow, and overall: delegations carrying a `verify` ref, refs minted, refs ' +
			'executed rather than reused, refs resolved by lookup, failed lookups, reuse rate, full validation passes ' +
			'charged, and executions per distinct repository-state digest. Deduplication means ' +
			'grouping records by `flowId`, counting the distinct `stateDigest` values across the ' +
			'refs minted in that flow, and dividing executed mints by that count, because a ratio ' +
			'above 1 is the duplicate execution this workstream exists to remove. When the producer invocation ' +
			'stream is present, its one-record-per-call execution decision refines the consumer-side telemetry; ' +
			'otherwise the report says only what the extension observed.',
	);
	lines.push('');
	const producerStreamStatus = !m.producerInvocationStream.available
		? 'Producer invocation stream: unavailable; producer execution columns are not zero-event evidence.'
		: m.producerInvocationStream.records === 0
			? `Producer invocation stream: present at \`${m.producerInvocationStream.path}\`, but it contains no verify records; producer execution columns use consumer telemetry fallback and are not zero-event evidence.`
			: `Producer invocation stream: \`${m.producerInvocationStream.path}\` (${m.producerInvocationStream.records} verify records).`;
	lines.push(producerStreamStatus);
	lines.push('');
	lines.push(row(validationColumns));
	lines.push(row(validationColumns.map((_, index) => (index === 0 ? '---' : '---:'))));
	lines.push(row(validationCells(m.validation.overall)));
	for (const v of m.validation.byRole) {
		lines.push(row(validationCells(v)));
	}
	lines.push('');
	lines.push('Per-flow reuse and lookup outcomes:');
	lines.push('');
	lines.push(row(validationDiagnosticColumns));
	lines.push(row(validationDiagnosticColumns.map((_, index) => (index === 0 ? '---' : '---:'))));
	for (const v of m.validation.byFlow) {
		lines.push(
			row([
				v.scope,
				v.lookupFailures,
				Object.entries(v.lookupFailureClasses)
					.map(([kind, count]) => `${kind}:${count}`)
					.join(',') || '-',
				v.reuseRate === null ? '-' : `${Math.round(v.reuseRate * 100)}%`,
				v.producerInvocations,
				v.producerExecutions,
				v.stateDriftExecutions,
				v.maxConcurrentExecutions,
			]),
		);
	}
	lines.push(row([VALIDATION_BASELINE_LABEL, ...validationColumns.slice(1).map(() => '-')]));
	lines.push('');
	lines.push('Read evidence refs, structured lookup outcomes, and codegraph index states:');
	lines.push('');
	lines.push(
		row([
			'scope',
			'read minted',
			'read reused',
			'read lookups',
			'lookup outcomes',
			'codegraph results',
			'index ids',
		]),
	);
	lines.push(row(['---', '---:', '---:', '---:', '---', '---:', '---:']));
	for (const v of [m.validation.overall, ...m.validation.byRole, ...m.validation.byFlow]) {
		lines.push(
			row([
				v.scope,
				v.readRefsMinted,
				v.readRefsReused,
				v.readRefsResolvedByLookup,
				Object.entries(v.lookupOutcomes)
					.map(([kind, count]) => `${kind}:${count}`)
					.join(',') || '-',
				v.codegraphIndexResults,
				v.codegraphIndexIds,
			]),
		);
	}
	lines.push('');
	lines.push('## Repository write lock contention (S2)');
	lines.push('');
	lines.push(
		'Counts consumer-enforced refusals while a sibling held the repository write lock. ' +
			'The validation table includes state-drift and concurrency diagnostics from all producer command records, ' +
			'not only verify calls; producer diagnostics remain unavailable when the stream is absent.',
	);
	lines.push('');
	lines.push(row(['scope', 'lock refusals']));
	lines.push(row(['---', '---:']));
	for (const v of [m.validation.overall, ...m.validation.byRole, ...m.validation.byFlow])
		lines.push(row([v.scope, v.lockContentionRefusals]));
	lines.push('');
	lines.push(
		'Every ref counted here was minted by a delegated child seat, because root ' +
			'spend is not in telemetry. Minting works and is authorized per `verify` call shape, so a zero ' +
			'here after children ran the gate means the shape was refused (the `F9` authorization ' +
			'boundary) rather than that validation was deduplicated.',
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
