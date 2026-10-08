import type { Message } from '@earendil-works/pi-ai';
import { getFinalOutput } from './format.ts';
import {
	classifyToolCall,
	isUnexecutedResolutionFailure,
	readPathOf,
	readRequestKey,
	splitReportOutput,
	verifyIsRefLookupOnly,
} from './budget.ts';
import type {
	ExecutionMetrics,
	LookupOutcome,
	ReadReference,
	SingleResult,
	ValidationExecution,
	ValidationLookupFailure,
	ValidationLookupFailureClass,
	ValidationReference,
} from './types.ts';

const MAX_READ_REFS = 24;
const MAX_READ_REF_LENGTH = 200;
const MAX_CODEGRAPH_INDEX_IDS = 8;
const MAX_INDEX_ID_LENGTH = 64;
const LOOKUP_OUTCOMES = new Set<LookupOutcome>([
	'success',
	'not-found',
	'unauthorized-flow',
	'corrupt',
]);

function normalizedPath(value: string): string {
	return value.replaceAll('\\', '/').replace(/\/$/, '');
}

export function measureExecutionMetrics(result: SingleResult, startedAt: number): ExecutionMetrics {
	let toolCalls = 0;
	let nestedToolCalls = 0;
	let failedToolCalls = 0;
	let repeatedReads = 0;
	let manifestRereads = 0;
	let discoveryCalls = 0;
	let fullValidationPasses = 0;
	let outputTokens = 0;
	let reportOutputTokens = 0;
	let toolArgumentOutputTokens = 0;
	let reasoningTokens = 0;
	let maxContextTokens = 0;
	let turns = 0;
	const readCounts = new Map<string, number>();
	const readPathCounts = new Map<string, number>();
	const validationCalls = new Map<
		string,
		{
			tool: 'verify' | 'project_command' | 'read_batch';
			lookup: boolean;
			ref?: string;
			commandId?: string;
			forced?: boolean;
		}
	>();
	const validationRefs: ValidationReference[] = [];
	const lookupFailures: ValidationLookupFailure[] = [];
	const validationExecutions: ValidationExecution[] = [];
	const readRefs: ReadReference[] = [];
	const codegraphIndexIds: string[] = [];
	let codegraphIndexResults = 0;
	for (const message of result.messages) {
		if (message.role === 'assistant') {
			turns++;
			const output = message.usage?.output ?? 0;
			outputTokens += output;
			if (message.content.some((part) => part.type === 'toolCall')) {
				toolArgumentOutputTokens += output;
			} else {
				const share = splitReportOutput(message.usage);
				reportOutputTokens += share.report;
				reasoningTokens += share.reasoning;
			}
			for (const part of message.content) {
				if (part.type !== 'toolCall') continue;
				toolCalls++;
				const category = classifyToolCall(part.name, part.arguments);
				if (category === 'discovery') discoveryCalls++;
				if (category === 'validation') fullValidationPasses++;
				if (part.name === 'verify' && part.id) {
					const lookup = verifyIsRefLookupOnly(part.arguments);
					validationCalls.set(part.id, {
						tool: 'verify',
						lookup,
						...(typeof part.arguments?.ref === 'string' ? { ref: part.arguments.ref } : {}),
						...(part.arguments?.fresh === true ? { forced: true } : {}),
					});
				}
				if (part.name === 'project_command' && category === 'validation' && part.id) {
					validationCalls.set(part.id, {
						tool: 'project_command',
						lookup: false,
						...(typeof part.arguments?.ref === 'string' ? { ref: part.arguments.ref } : {}),
						...(typeof part.arguments?.commandId === 'string'
							? { commandId: part.arguments.commandId }
							: {}),
					});
				}
				if (part.name === 'read_batch' && part.id) {
					validationCalls.set(part.id, {
						tool: 'read_batch',
						lookup: typeof part.arguments?.ref === 'string',
						...(typeof part.arguments?.ref === 'string' ? { ref: part.arguments.ref } : {}),
					});
				}
				if (part.name === 'read') {
					const readPath = readPathOf(part.arguments);
					if (readPath) {
						const normalized = normalizedPath(readPath);
						const count = readPathCounts.get(normalized) ?? 0;
						if (
							count > 0 &&
							result.readManifest?.doNotReread.some((path) => normalizedPath(path) === normalized)
						)
							manifestRereads++;
						readPathCounts.set(normalized, count + 1);
					}
					const key = readRequestKey(part.arguments);
					if (key) {
						const count = readCounts.get(key) ?? 0;
						if (count > 0) repeatedReads++;
						readCounts.set(key, count + 1);
					}
				}
			}
			maxContextTokens = Math.max(maxContextTokens, message.usage?.totalTokens || 0);
		} else if (message.role === 'toolResult') {
			if (message.isError) failedToolCalls++;
			// Nested calls (ctx.executeTool) never enter the transcript; their bounded record is kept
			// on the calling tool's result message, flattened per parent, so each nested call is
			// counted exactly once here. An incomplete record (`complete: false`) is a lower bound.
			nestedToolCalls += message.nestedCalls?.calls.length ?? 0;
			const pendingCall = validationCalls.get(message.toolCallId);
			// A result settles only the call with both the same id and originating tool name. Removing
			// it before extracting evidence makes duplicate results inert without changing tool failure
			// accounting above.
			const call = pendingCall?.tool === message.toolName ? pendingCall : undefined;
			if (call) validationCalls.delete(message.toolCallId);
			// Classify the producer result before touching refs or execution evidence. This is independent
			// of isError: malformed producer envelopes must not mint evidence when isError is false.
			const unexecutedResolutionFailure =
				call !== undefined && isUnexecutedResolutionFailure(message.details, message.content);
			if (call?.tool === 'verify' && !unexecutedResolutionFailure) {
				const reference = verifyReferenceOf(message, call.lookup, call.forced);
				if (reference) validationRefs.push(reference);
				if (message.isError && call.lookup)
					lookupFailures.push(verifyLookupFailureOf(message, call.ref));
			}
			if (
				call?.tool === 'read_batch' &&
				!unexecutedResolutionFailure &&
				message.isError &&
				call.lookup
			) {
				lookupFailures.push(verifyLookupFailureOf(message, call.ref));
			}
			// The validation pass is charged at issue and never refunded: a preflight rejection only
			// suppresses evidence (refs, executions, lookup failures), not the charge.
			if (call?.tool === 'read_batch' && !unexecutedResolutionFailure && !message.isError) {
				const observed = readRefsOf(message);
				for (const entry of observed) {
					if (readRefs.length >= MAX_READ_REFS) break;
					readRefs.push(entry);
				}
			}
			const indexId = codegraphIndexIdOf(message);
			if (indexId !== undefined && !unexecutedResolutionFailure) {
				codegraphIndexResults++;
				if (
					!codegraphIndexIds.includes(indexId) &&
					codegraphIndexIds.length < MAX_CODEGRAPH_INDEX_IDS
				)
					codegraphIndexIds.push(indexId);
			}
			if (
				call &&
				(call.tool === 'verify' || call.tool === 'project_command') &&
				!call.lookup &&
				!unexecutedResolutionFailure
			) {
				validationExecutions.push(validationExecutionOf(message, call));
			}
		}
	}
	return {
		durationMs: Math.max(0, Date.now() - startedAt),
		toolCalls,
		nestedToolCalls,
		failedToolCalls,
		repeatedReads,
		manifestRereads,
		messageCount: result.messages.length,
		taskChars: result.task.length,
		outputChars: getFinalOutput(result.messages).length,
		maxContextTokens,
		turns,
		blockEvents: result.blockDurations?.count ?? 0,
		approvalMs: result.blockDurations?.approvalMs ?? 0,
		steerMs: result.blockDurations?.steerMs ?? 0,
		discoveryCalls,
		fullValidationPasses,
		outputTokens,
		reportOutputTokens,
		toolArgumentOutputTokens,
		reasoningTokens,
		...(validationRefs.length > 0 ? { validationRefs } : {}),
		...(lookupFailures.length > 0 ? { lookupFailures } : {}),
		...(validationExecutions.length > 0 ? { validationExecutions } : {}),
		...(readRefs.length > 0 ? { readRefs } : {}),
		...(codegraphIndexResults > 0
			? { codegraphIndex: { results: codegraphIndexResults, indexIds: codegraphIndexIds } }
			: {}),
	};
}

function jsonPayloadOf(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === 'string') {
		try {
			const parsed: unknown = JSON.parse(value);
			return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: undefined;
		} catch {
			return undefined;
		}
	}
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function payloadCandidates(message: Message): Record<string, unknown>[] {
	if (message.role !== 'toolResult') return [];
	const candidates: Record<string, unknown>[] = [];
	for (const candidate of [
		message.details,
		...message.content
			.filter((part) => part.type === 'text')
			.map((part) => (part as { text?: string }).text),
	]) {
		const payload = jsonPayloadOf(candidate);
		if (payload) candidates.push(payload);
	}
	return candidates;
}

function shortHash(value: unknown): string | undefined {
	return typeof value === 'string' ? value.slice(0, 12) : undefined;
}

function stateOf(payload: Record<string, unknown>): Record<string, unknown> | undefined {
	return jsonPayloadOf(payload.repositoryState) ?? jsonPayloadOf(payload.repository_state);
}

const WORKSPACE_STATUSES = new Set(['readable', 'degraded', 'unreadable', 'non-git']);

/**
 * Reads the producer-neutral shared evidence envelope `workspace` block (`head`, `dirtyDigest`,
 * `status`). Bash-tools narrows `status` to `readable` and `degraded`; codegraph-runner widens it
 * with `unreadable` and `non-git`. An unknown or malformed shape is treated as absent so the
 * producer detail fields and snake_case aliases stay the fallback.
 */
function workspaceOf(payload: Record<string, unknown>): Record<string, unknown> | undefined {
	const block = jsonPayloadOf(payload.workspace);
	if (!block) return undefined;
	if (typeof block.status !== 'string' || !WORKSPACE_STATUSES.has(block.status)) return undefined;
	if (block.head !== null && typeof block.head !== 'string') return undefined;
	if (block.dirtyDigest !== null && typeof block.dirtyDigest !== 'string') return undefined;
	return block;
}

function stringValue(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		if (typeof payload[key] === 'string' && payload[key]) return payload[key] as string;
	}
	return undefined;
}

function booleanValue(payload: Record<string, unknown>, ...keys: string[]): boolean | undefined {
	for (const key of keys) if (typeof payload[key] === 'boolean') return payload[key] as boolean;
	return undefined;
}

function numberValue(payload: Record<string, unknown>, ...keys: string[]): number | undefined {
	for (const key of keys) {
		if (typeof payload[key] === 'number' && Number.isFinite(payload[key]))
			return payload[key] as number;
	}
	return undefined;
}

function repositoryStateStatusOf(
	payload: Record<string, unknown>,
): ValidationReference['repositoryStateStatus'] {
	const state = stateOf(payload) ?? {};
	const comparison = jsonPayloadOf(state.comparison) ?? {};
	const value =
		stringValue(payload, 'repositoryStateStatus', 'repository_state_status') ??
		stringValue(state, 'repositoryStateStatus', 'repository_state_status', 'status') ??
		stringValue(comparison, 'repositoryStateStatus', 'status');
	if (value === 'matches' || value === 'mismatch' || value === 'unreadable') return value;
	// A degraded or unreadable workspace observation cannot confirm freshness; map it to the
	// producer comparison vocabulary's conservative verdict instead of claiming a match.
	const workspace = workspaceOf(payload);
	if (workspace && (workspace.status === 'degraded' || workspace.status === 'unreadable'))
		return 'unreadable';
	return undefined;
}

function omittedPhasesOf(payload: Record<string, unknown>): string[] {
	const omitted = new Set<string>();
	const explicit = payload.omitted;
	if (Array.isArray(explicit)) {
		for (const phase of explicit) if (typeof phase === 'string' && phase) omitted.add(phase);
	}
	for (const sourceName of ['phases', 'perStep', 'per_step', 'steps']) {
		const source = jsonPayloadOf(payload[sourceName]);
		if (!source) continue;
		for (const [phase, value] of Object.entries(source)) {
			const status = typeof value === 'string' ? value : jsonPayloadOf(value)?.status;
			if (typeof status === 'string' && status.toLowerCase() === 'omitted') omitted.add(phase);
		}
	}
	return [...omitted];
}

interface ProducerFields {
	decision?: string;
	cacheDecision?: string;
	publication?: 'published' | 'unauthorized' | 'unavailable' | 'failed';
	publicationReason?: string;
	flowId?: string;
	flowIdConflict?: boolean;
}

interface PublicationFields {
	publication?: ProducerFields['publication'];
	publicationReason?: string;
}

const PUBLICATION_STATES = new Set(['published', 'unauthorized', 'unavailable', 'failed']);
const MAX_PUBLICATION_REASON = 200;

/**
 * Normalizes the two producer publication vocabularies into one state set before any surfacing in
 * digests, reports, or telemetry. Bash-tools reports `{ published, error }`; codegraph-runner reports
 * `{ state, reason }`. The codegraph states are the neutral vocabulary because they are the more
 * expressive set, so a bash-tools `published: false` becomes `failed` and its `error` text becomes
 * the reason. Unrecognized shapes are treated as absent.
 */
function publicationFieldsOf(object: Record<string, unknown>): PublicationFields {
	const block = jsonPayloadOf(object.publication) ?? jsonPayloadOf(object.publish);
	if (!block) return {};
	if (typeof block.state === 'string' && PUBLICATION_STATES.has(block.state)) {
		const reason = boundedPublicationReason(block.reason);
		return {
			publication: block.state as PublicationFields['publication'],
			...(reason ? { publicationReason: reason } : {}),
		};
	}
	if (typeof block.published === 'boolean') {
		if (block.published) return { publication: 'published' };
		const reason = boundedPublicationReason(block.error);
		return { publication: 'failed', ...(reason ? { publicationReason: reason } : {}) };
	}
	return {};
}

function boundedPublicationReason(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const flat = value.replace(/\s+/g, ' ').trim();
	if (!flat) return undefined;
	return flat.length > MAX_PUBLICATION_REASON
		? `${flat.slice(0, MAX_PUBLICATION_REASON)}...`
		: flat;
}

/** Clamps an untrusted lookup-outcome string to the bounded enum. */
function lookupOutcomeOf(payload: Record<string, unknown>): LookupOutcome | undefined {
	const block = jsonPayloadOf(payload.lookup);
	if (!block) return undefined;
	const value = stringValue(block, 'outcome');
	if (value === undefined) return undefined;
	const normalized = value.toLowerCase();
	return LOOKUP_OUTCOMES.has(normalized as LookupOutcome)
		? (normalized as LookupOutcome)
		: undefined;
}

/** Reads a bounded producer lookup-outcome from any payload candidate of one tool result. */
function lookupOutcomeOfMessage(message: Message): LookupOutcome | undefined {
	for (const payload of payloadCandidates(message)) {
		const outcome = lookupOutcomeOf(payload);
		if (outcome !== undefined) return outcome;
	}
	return undefined;
}

/**
 * Extracts read_batch evidence refs from one tool result: minted refs from the per-item `results`
 * array, or one confirmed ref from a successful ref lookup. Provenance flags travel with the entry
 * so the manifest projection can drop refs that cannot resolve inside this flow.
 */
function readRefsOf(message: Message): ReadReference[] {
	const producer = producerFieldsOfMessage(message);
	for (const payload of payloadCandidates(message)) {
		if (Array.isArray(payload.results)) {
			const publication = publicationFieldsOf(payload);
			const refs: ReadReference[] = [];
			for (const item of payload.results) {
				const entry = jsonPayloadOf(item);
				if (!entry) continue;
				const ref = typeof entry.ref === 'string' ? entry.ref.trim() : '';
				if (!ref || ref.length > MAX_READ_REF_LENGTH) continue;
				refs.push({
					ref,
					reused: entry.unchanged === true,
					...(publication.publication === undefined
						? {}
						: { publication: publication.publication }),
					...(publication.publicationReason === undefined
						? {}
						: { publicationReason: publication.publicationReason }),
					...(producer.flowIdConflict ? { flowIdConflict: true } : {}),
					...(producer.flowIdConflict || producer.flowId === undefined
						? {}
						: { flowId: producer.flowId }),
				});
			}
			if (refs.length > 0) return refs;
		}
		const lookup = jsonPayloadOf(payload.lookup);
		if (lookup && typeof lookup.ref === 'string') {
			const ref = lookup.ref.trim();
			if (!ref || ref.length > MAX_READ_REF_LENGTH) continue;
			const status = stringValue(lookup, 'repositoryStateStatus');
			return [
				{
					ref,
					reused: true,
					lookup: true,
					...(status === 'matches' || status === 'mismatch' || status === 'unreadable'
						? { repositoryStateStatus: status }
						: {}),
					...(producer.flowIdConflict ? { flowIdConflict: true } : {}),
					...(producer.flowIdConflict || producer.flowId === undefined
						? {}
						: { flowId: producer.flowId }),
				},
			];
		}
	}
	return [];
}

/** Reads the codegraph producer index id from a result's `producerState` block. */
function codegraphIndexIdOf(message: Message): string | undefined {
	for (const payload of payloadCandidates(message)) {
		const state = jsonPayloadOf(payload.producerState);
		if (!state) continue;
		const id = stringValue(state, 'indexId', 'index_id');
		if (id && id.length <= MAX_INDEX_ID_LENGTH) return id;
	}
	return undefined;
}

/**
 * Reads producer metadata from both the direct result and nested diagnostic objects. Flow identity is
 * deliberately narrower than the decision fields: only a direct flowId or flowId under provenance or
 * publication is producer provenance. In particular, producerScope is not a flow identifier.
 */
function producerFieldsOf(payload: Record<string, unknown>): ProducerFields {
	let decision: string | undefined;
	let cacheDecision: string | undefined;
	let publication: ProducerFields['publication'];
	let publicationReason: string | undefined;
	const flowIds = new Set<string>();
	const directFlowId = stringValue(payload, 'flowId', 'flow_id');
	if (directFlowId !== undefined) flowIds.add(directFlowId);

	function visit(value: unknown, path: string[], depth: number): void {
		const object = jsonPayloadOf(value);
		if (!object) return;
		decision ??= stringValue(object, 'decision', 'producerDecision', 'producer_decision');
		cacheDecision ??= stringValue(object, 'cacheDecision', 'cache_decision');
		const candidatePublication = publicationFieldsOf(object);
		publication ??= candidatePublication.publication;
		publicationReason ??= candidatePublication.publicationReason;
		const parent = path[path.length - 1];
		if (parent === 'provenance' || parent === 'publication' || parent === 'publish') {
			const nestedFlowId = stringValue(object, 'flowId', 'flow_id');
			if (nestedFlowId !== undefined) flowIds.add(nestedFlowId);
		}
		if (depth >= 4) return;
		for (const [key, nested] of Object.entries(object)) visit(nested, [...path, key], depth + 1);
	}

	visit(payload, [], 0);
	const flowIdConflict = flowIds.size > 1;
	const flowId = flowIds.size === 1 ? [...flowIds][0] : undefined;
	return {
		...(decision === undefined ? {} : { decision }),
		...(cacheDecision === undefined ? {} : { cacheDecision }),
		...(publication === undefined ? {} : { publication }),
		...(publicationReason === undefined ? {} : { publicationReason }),
		...(flowIdConflict ? { flowIdConflict: true } : {}),
		...(flowIdConflict || flowId === undefined ? {} : { flowId }),
	};
}

function producerFieldsOfMessage(message: Message): ProducerFields {
	let fields: ProducerFields = {};
	let flowId: string | undefined;
	let flowIdConflict = false;
	for (const payload of payloadCandidates(message)) {
		const candidate = producerFieldsOf(payload);
		if (candidate.flowIdConflict) flowIdConflict = true;
		if (candidate.flowId !== undefined) {
			if (flowId !== undefined && flowId !== candidate.flowId) flowIdConflict = true;
			flowId ??= candidate.flowId;
		}
		fields = {
			...(fields.decision === undefined && candidate.decision === undefined
				? {}
				: { decision: fields.decision ?? candidate.decision }),
			...(fields.cacheDecision === undefined && candidate.cacheDecision === undefined
				? {}
				: { cacheDecision: fields.cacheDecision ?? candidate.cacheDecision }),
		};
	}
	return {
		...fields,
		...(flowIdConflict ? { flowIdConflict: true } : {}),
		...(flowIdConflict || flowId === undefined ? {} : { flowId }),
	};
}

function producerEvidenceFieldsOf(
	producer: ProducerFields,
	messageFlowIdConflict = false,
): Pick<
	ValidationReference,
	'decision' | 'cacheDecision' | 'publication' | 'publicationReason' | 'flowId' | 'flowIdConflict'
> {
	return {
		...(producer.decision === undefined ? {} : { decision: producer.decision }),
		...(producer.cacheDecision === undefined ? {} : { cacheDecision: producer.cacheDecision }),
		...(producer.publication === undefined ? {} : { publication: producer.publication }),
		...(producer.publicationReason === undefined
			? {}
			: { publicationReason: producer.publicationReason }),
		...(messageFlowIdConflict || producer.flowIdConflict ? { flowIdConflict: true } : {}),
		...(messageFlowIdConflict || producer.flowIdConflict || producer.flowId === undefined
			? {}
			: { flowId: producer.flowId }),
	};
}

function validationFieldsOf(
	payload: Record<string, unknown>,
	messageFlowIdConflict = false,
): Omit<ValidationReference, 'ref' | 'reused' | 'lookup'> {
	const state = stateOf(payload);
	const execution = jsonPayloadOf(payload.execution) ?? {};
	const producer = producerFieldsOf(payload);
	// The shared workspace block is the primary freshness input; a degraded or unreadable block is
	// not a complete identity, so producer detail fields win there. Null block values are unknown
	// state and also fall through to the producer detail fields.
	const workspace = workspaceOf(payload);
	const workspaceUsable =
		workspace !== undefined && (workspace.status === 'readable' || workspace.status === 'non-git');
	const head = shortHash((workspaceUsable ? workspace.head : undefined) ?? state?.head);
	const stateDigest = shortHash(
		(workspaceUsable ? workspace.dirtyDigest : undefined) ??
			state?.dirtyFilesDigest ??
			state?.dirty_digest,
	);
	const stateDrift =
		booleanValue(payload, 'stateDrift', 'state_drift') ??
		booleanValue(execution, 'stateDrift', 'state_drift');
	const concurrentExecutions =
		numberValue(payload, 'concurrentExecutions', 'concurrent_executions') ??
		numberValue(execution, 'concurrentExecutions', 'concurrent_executions');
	const mutating = booleanValue(payload, 'mutating') ?? booleanValue(execution, 'mutating');
	const forced =
		booleanValue(payload, 'forced') ??
		booleanValue(execution, 'forced') ??
		(producer.decision === 'forced' ? true : undefined);
	const repositoryStateStatus = repositoryStateStatusOf(payload);
	const omitted = omittedPhasesOf(payload);
	return {
		...(head === undefined ? {} : { head }),
		...(stateDigest === undefined ? {} : { stateDigest }),
		...(repositoryStateStatus === undefined ? {} : { repositoryStateStatus }),
		...(stateDrift === undefined ? {} : { stateDrift }),
		...(concurrentExecutions === undefined ? {} : { concurrentExecutions }),
		...(mutating === undefined ? {} : { mutating }),
		...(forced === undefined ? {} : { forced }),
		...producerEvidenceFieldsOf(producer, messageFlowIdConflict),
		...(omitted.length > 0 ? { omitted } : {}),
	};
}

/**
 * Extracts the tool-issued ref from a validation result, preferring structured details and falling back
 * to the JSON text payload. A passed run with omitted phases is represented as incomplete instead of passed.
 */
function verifyReferenceOf(
	message: Message,
	lookup: boolean | undefined,
	forcedHint?: boolean,
): ValidationReference | undefined {
	if (message.role !== 'toolResult' || message.toolName !== 'verify' || message.isError)
		return undefined;
	const producer = producerFieldsOfMessage(message);
	for (const payload of payloadCandidates(message)) {
		if (typeof payload.ref !== 'string' || payload.ref.length === 0) continue;
		const omitted = omittedPhasesOf(payload);
		const rawVerdict =
			typeof payload.verdict === 'string' ? payload.verdict.toLowerCase() : undefined;
		const verdict = omitted.length > 0 && rawVerdict === 'passed' ? 'incomplete' : rawVerdict;
		const resolvesByLookup = lookup ?? payload.reused === true;
		const lookupOutcome =
			lookupOutcomeOf(payload) ??
			// Verify lookup results do not carry the structured block; a ref-only call that reports
			// reused evidence is by definition a successful lookup.
			(resolvesByLookup && payload.reused === true ? ('success' as const) : undefined);
		return {
			ref: payload.ref,
			...(verdict === 'passed' || verdict === 'failed' || verdict === 'incomplete'
				? { verdict }
				: {}),
			reused: payload.reused === true,
			lookup: resolvesByLookup,
			...(lookupOutcome === undefined ? {} : { lookupOutcome }),
			...validationFieldsOf(payload, producer.flowIdConflict === true),
			...(forcedHint !== undefined && payload.forced === undefined ? { forced: forcedHint } : {}),
		};
	}
	return undefined;
}

function detailsOf(message: Message): unknown {
	return 'details' in message ? message.details : undefined;
}

function nestedStrings(value: unknown, depth = 0): string[] {
	if (depth > 3) return [];
	if (typeof value === 'string') return [value];
	if (Array.isArray(value)) return value.flatMap((item) => nestedStrings(item, depth + 1));
	if (!value || typeof value !== 'object') return [];
	return Object.entries(value).flatMap(([key, item]) =>
		[key].concat(nestedStrings(item, depth + 1)),
	);
}

function errorClassOf(message: Message): ValidationLookupFailureClass {
	const text = nestedStrings(detailsOf(message))
		.concat(
			message.role === 'toolResult'
				? message.content
						.filter((part) => part.type === 'text')
						.map((part) => (part as { text?: string }).text ?? '')
				: [],
		)
		.join(' ')
		.toLowerCase();
	if (/denied|forbidden|permission|unauthori[sz]ed|authorization|refused/.test(text))
		return 'denied';
	if (/timed?\s*out|timeout|deadline exceeded/.test(text)) return 'timeout';
	if (/not[-_ ]found|does not exist|unknown ref|missing ref|no such ref/.test(text))
		return 'not-found';
	return 'unknown';
}

function errorMessageOf(message: Message): string | undefined {
	for (const payload of payloadCandidates(message)) {
		const value = stringValue(payload, 'message', 'error', 'reason', 'detail');
		if (value) return value.slice(0, 240);
	}
	if (message.role === 'toolResult') {
		const text = message.content
			.filter((part) => part.type === 'text')
			.map((part) => (part as { text?: string }).text ?? '')
			.join(' ')
			.trim();
		const payload = jsonPayloadOf(text);
		const value = payload && stringValue(payload, 'message', 'error', 'reason', 'detail');
		if (value) return value.slice(0, 240);
		if (text) return text.slice(0, 240);
	}
	return undefined;
}

function verifyLookupFailureOf(message: Message, ref?: string): ValidationLookupFailure {
	const producer = producerFieldsOfMessage(message);
	const lookupOutcome = lookupOutcomeOfMessage(message);
	return {
		...(ref ? { ref } : {}),
		errorClass: errorClassOf(message),
		...(errorMessageOf(message) ? { message: errorMessageOf(message) } : {}),
		...(lookupOutcome === undefined ? {} : { lookupOutcome }),
		...(producer.decision === undefined ? {} : { decision: producer.decision }),
		...(producer.cacheDecision === undefined ? {} : { cacheDecision: producer.cacheDecision }),
		...(producer.flowId === undefined ? {} : { flowId: producer.flowId }),
		...(producer.flowIdConflict ? { flowIdConflict: true } : {}),
	};
}

function validationExecutionOf(
	message: Message,
	call: {
		tool: 'verify' | 'project_command' | 'read_batch';
		ref?: string;
		commandId?: string;
		forced?: boolean;
	},
): ValidationExecution {
	const payload = payloadCandidates(message)[0];
	const fields = payload ? validationFieldsOf(payload) : {};
	const producer = producerFieldsOfMessage(message);
	const publication = payload ? publicationFieldsOf(payload) : {};
	const producedRef =
		typeof payload?.ref === 'string' && payload.ref.length > 0 ? payload.ref : undefined;
	return {
		tool: call.tool as 'verify' | 'project_command',
		...(call.ref || producedRef ? { ref: call.ref ?? producedRef } : {}),
		...(call.commandId ? { commandId: call.commandId } : {}),
		...(fields.stateDrift === undefined ? {} : { stateDrift: fields.stateDrift }),
		...(fields.concurrentExecutions === undefined
			? {}
			: { concurrentExecutions: fields.concurrentExecutions }),
		...(fields.mutating === undefined ? {} : { mutating: fields.mutating }),
		...(fields.forced === undefined && call.forced === undefined
			? {}
			: { forced: fields.forced ?? call.forced }),
		...producerEvidenceFieldsOf(producer),
		...(publication.publication === undefined ? {} : { publication: publication.publication }),
		...(publication.publicationReason === undefined
			? {}
			: { publicationReason: publication.publicationReason }),
	};
}

export function outputTokensOf(messages: Message[]): number {
	return messages.reduce(
		(total, message) => total + (message.role === 'assistant' ? (message.usage?.output ?? 0) : 0),
		0,
	);
}
