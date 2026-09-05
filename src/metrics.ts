import type { Message } from '@earendil-works/pi-ai';
import { getFinalOutput } from './format.ts';
import {
	classifyToolCall,
	readPathOf,
	readRequestKey,
	splitReportOutput,
	verifyResolvesRef,
} from './budget.ts';
import type { ExecutionMetrics, SingleResult, ValidationReference } from './types.ts';

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
	const verifyLookups = new Map<string, boolean>();
	const validationRefs: ValidationReference[] = [];
	for (const message of result.messages) {
		if (message.role === 'assistant') {
			turns++;
			const output = message.usage?.output ?? 0;
			outputTokens += output;
			if (message.content.some((part) => part.type === 'toolCall')) {
				toolArgumentOutputTokens += output;
			} else {
				// The report budget measures report prose, not thinking.
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
				if (part.name === 'verify') verifyLookups.set(part.id, verifyResolvesRef(part.arguments));
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
			const reference = verifyReferenceOf(message, verifyLookups.get(message.toolCallId));
			if (reference) validationRefs.push(reference);
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

function shortHash(value: unknown): string | undefined {
	return typeof value === 'string' ? value.slice(0, 12) : undefined;
}

/**
 * Extracts the tool-issued ref from a `verify` result, preferring structured details and falling back
 * to the JSON text payload. The ref is what makes validation evidence reusable, so it is recorded even
 * when the run reused or omitted phases.
 */
export function verifyReferenceOf(
	message: Message,
	lookup: boolean | undefined,
): ValidationReference | undefined {
	if (message.role !== 'toolResult' || message.toolName !== 'verify') return undefined;
	const candidates: unknown[] = [
		message.details,
		...message.content
			.filter((part) => part.type === 'text')
			.map((part) => (part as { text?: string }).text),
	];
	for (const candidate of candidates) {
		const payload = jsonPayloadOf(candidate);
		if (!payload || typeof payload.ref !== 'string' || payload.ref.length === 0) continue;
		const verdict = payload.verdict;
		const reused = payload.reused === true;
		const state = jsonPayloadOf(payload.repositoryState);
		const head = shortHash(state?.head);
		const stateDigest = shortHash(state?.dirtyFilesDigest);
		return {
			ref: payload.ref,
			...(verdict === 'passed' || verdict === 'failed' || verdict === 'incomplete'
				? { verdict }
				: {}),
			reused,
			lookup: lookup ?? reused,
			...(head === undefined ? {} : { head }),
			...(stateDigest === undefined ? {} : { stateDigest }),
		};
	}
	return undefined;
}

export function outputTokensOf(messages: Message[]): number {
	return messages.reduce(
		(total, message) => total + (message.role === 'assistant' ? (message.usage?.output ?? 0) : 0),
		0,
	);
}
