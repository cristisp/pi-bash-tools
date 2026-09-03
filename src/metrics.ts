import type { Message } from '@earendil-works/pi-ai';
import { getFinalOutput } from './format.ts';
import { classifyToolCall, readPathOf, readRequestKey } from './budget.ts';
import type { ExecutionMetrics, SingleResult } from './types.ts';

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
	let maxContextTokens = 0;
	let turns = 0;
	const readCounts = new Map<string, number>();
	const readPathCounts = new Map<string, number>();
	for (const message of result.messages) {
		if (message.role === 'assistant') {
			turns++;
			outputTokens += message.usage?.output ?? 0;
			for (const part of message.content) {
				if (part.type !== 'toolCall') continue;
				toolCalls++;
				const category = classifyToolCall(part.name, part.arguments);
				if (category === 'discovery') discoveryCalls++;
				if (category === 'validation') fullValidationPasses++;
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
		} else if (message.role === 'toolResult' && message.isError) {
			failedToolCalls++;
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
	};
}

export function outputTokensOf(messages: Message[]): number {
	return messages.reduce(
		(total, message) => total + (message.role === 'assistant' ? (message.usage?.output ?? 0) : 0),
		0,
	);
}
