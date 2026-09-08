import type { Message } from '@earendil-works/pi-ai';
import { getFinalOutput } from './format.ts';
import {
	classifyToolCall,
	readPathOf,
	readRequestKey,
	splitReportOutput,
	verifyIsRefLookupOnly,
} from './budget.ts';
import type {
	ExecutionMetrics,
	SingleResult,
	ValidationExecution,
	ValidationLookupFailure,
	ValidationLookupFailureClass,
	ValidationReference,
} from './types.ts';

export function normalizedPath(value: string): string {
	return value.replaceAll('\\', '/').replace(/\/$/, '');
}

export function measureExecutionMetrics(result: SingleResult, startedAt: number): ExecutionMetrics {
	let toolCalls = 0;
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
			tool: 'verify' | 'project_command';
			lookup: boolean;
			ref?: string;
			commandId?: string;
			forced?: boolean;
		}
	>();
	const validationRefs: ValidationReference[] = [];
	const lookupFailures: ValidationLookupFailure[] = [];
	const validationExecutions: ValidationExecution[] = [];
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
				if (part.name === 'verify') {
					const lookup = verifyIsRefLookupOnly(part.arguments);
					validationCalls.set(part.id, {
						tool: 'verify',
						lookup,
						...(typeof part.arguments?.ref === 'string' ? { ref: part.arguments.ref } : {}),
						...(part.arguments?.fresh === true ? { forced: true } : {}),
					});
				}
				if (part.name === 'project_command' && category === 'validation') {
					validationCalls.set(part.id, {
						tool: 'project_command',
						lookup: false,
						...(typeof part.arguments?.ref === 'string' ? { ref: part.arguments.ref } : {}),
						...(typeof part.arguments?.commandId === 'string'
							? { commandId: part.arguments.commandId }
							: {}),
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
			const call = validationCalls.get(message.toolCallId);
			if (call?.tool === 'verify') {
				const reference = verifyReferenceOf(message, call.lookup, call.forced);
				if (reference) validationRefs.push(reference);
				if (message.isError && call.lookup)
					lookupFailures.push(verifyLookupFailureOf(message, call.ref));
			}
			if (call && !call.lookup) {
				validationExecutions.push(validationExecutionOf(message, call));
			}
		}
	}
	return {
		durationMs: Math.max(0, Date.now() - startedAt),
		toolCalls,
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
	return value === 'matches' || value === 'mismatch' || value === 'unreadable' ? value : undefined;
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
	flowId?: string;
	flowIdConflict?: boolean;
}

/**
 * Reads producer metadata from both the direct result and nested diagnostic objects. Flow identity is
 * deliberately narrower than the decision fields: only a direct flowId or flowId under provenance or
 * publication is producer provenance. In particular, producerScope is not a flow identifier.
 */
function producerFieldsOf(payload: Record<string, unknown>): ProducerFields {
	let decision: string | undefined;
	let cacheDecision: string | undefined;
	const flowIds = new Set<string>();
	const directFlowId = stringValue(payload, 'flowId', 'flow_id');
	if (directFlowId !== undefined) flowIds.add(directFlowId);

	function visit(value: unknown, path: string[], depth: number): void {
		const object = jsonPayloadOf(value);
		if (!object) return;
		decision ??= stringValue(object, 'decision', 'producerDecision', 'producer_decision');
		cacheDecision ??= stringValue(object, 'cacheDecision', 'cache_decision');
		const parent = path[path.length - 1];
		if (parent === 'provenance' || parent === 'publication') {
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

function validationFieldsOf(
	payload: Record<string, unknown>,
	messageFlowIdConflict = false,
): Omit<ValidationReference, 'ref' | 'reused' | 'lookup'> {
	const state = stateOf(payload);
	const execution = jsonPayloadOf(payload.execution) ?? {};
	const producer = producerFieldsOf(payload);
	const head = shortHash(state?.head);
	const stateDigest = shortHash(state?.dirtyFilesDigest ?? state?.dirty_digest);
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
		...(producer.decision === undefined ? {} : { decision: producer.decision }),
		...(producer.cacheDecision === undefined ? {} : { cacheDecision: producer.cacheDecision }),
		...(messageFlowIdConflict || producer.flowIdConflict ? { flowIdConflict: true } : {}),
		...(messageFlowIdConflict || producer.flowIdConflict || producer.flowId === undefined
			? {}
			: { flowId: producer.flowId }),
		...(omitted.length > 0 ? { omitted } : {}),
	};
}

/**
 * Extracts the tool-issued ref from a validation result, preferring structured details and falling back
 * to the JSON text payload. A passed run with omitted phases is represented as incomplete instead of passed.
 */
export function verifyReferenceOf(
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
		return {
			ref: payload.ref,
			...(verdict === 'passed' || verdict === 'failed' || verdict === 'incomplete'
				? { verdict }
				: {}),
			reused: payload.reused === true,
			lookup: lookup ?? payload.reused === true,
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

export function verifyLookupFailureOf(message: Message, ref?: string): ValidationLookupFailure {
	const producer = producerFieldsOfMessage(message);
	return {
		...(ref ? { ref } : {}),
		errorClass: errorClassOf(message),
		...(errorMessageOf(message) ? { message: errorMessageOf(message) } : {}),
		...(producer.decision === undefined ? {} : { decision: producer.decision }),
		...(producer.cacheDecision === undefined ? {} : { cacheDecision: producer.cacheDecision }),
		...(producer.flowId === undefined ? {} : { flowId: producer.flowId }),
		...(producer.flowIdConflict ? { flowIdConflict: true } : {}),
	};
}

function validationExecutionOf(
	message: Message,
	call: { tool: 'verify' | 'project_command'; ref?: string; commandId?: string; forced?: boolean },
): ValidationExecution {
	const payload = payloadCandidates(message)[0];
	const fields = payload ? validationFieldsOf(payload) : {};
	const producer = producerFieldsOfMessage(message);
	return {
		tool: call.tool,
		...(call.ref ? { ref: call.ref } : {}),
		...(call.commandId ? { commandId: call.commandId } : {}),
		...(fields.stateDrift === undefined ? {} : { stateDrift: fields.stateDrift }),
		...(fields.concurrentExecutions === undefined
			? {}
			: { concurrentExecutions: fields.concurrentExecutions }),
		...(fields.mutating === undefined ? {} : { mutating: fields.mutating }),
		...(fields.forced === undefined && call.forced === undefined
			? {}
			: { forced: fields.forced ?? call.forced }),
		...(producer.decision === undefined ? {} : { decision: producer.decision }),
		...(producer.cacheDecision === undefined ? {} : { cacheDecision: producer.cacheDecision }),
		...(producer.flowId === undefined ? {} : { flowId: producer.flowId }),
		...(producer.flowIdConflict ? { flowIdConflict: true } : {}),
	};
}

export function outputTokensOf(messages: Message[]): number {
	return messages.reduce(
		(total, message) => total + (message.role === 'assistant' ? (message.usage?.output ?? 0) : 0),
		0,
	);
}
