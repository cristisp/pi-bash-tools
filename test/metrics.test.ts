import { describe, expect, it } from 'vitest';
import { measureExecutionMetrics, outputTokensOf } from '../src/metrics.ts';
import { assistantMsg, makeSingleResult, toolResultMsg } from './helpers.ts';

describe('measureExecutionMetrics', () => {
	it('counts classified calls, failed calls, repeated reads, and output tokens', () => {
		const messages = [
			assistantMsg('work', {
				usage: { output: 42, totalTokens: 50 },
				toolCalls: [
					{ id: 'r1', name: 'read', args: { path: 'src/a.ts' } },
					{ id: 'v1', name: 'project_command', args: { commandId: 'node_test' } },
					{ id: 'r2', name: 'read', args: { path: 'src/a.ts' } },
				],
			}),
			{ ...toolResultMsg('r1'), isError: true },
		];
		const metrics = measureExecutionMetrics(makeSingleResult({ messages }), Date.now() - 10);

		expect(metrics.toolCalls).toBe(3);
		expect(metrics.discoveryCalls).toBe(2);
		expect(metrics.fullValidationPasses).toBe(1);
		expect(metrics.failedToolCalls).toBe(1);
		expect(metrics.repeatedReads).toBe(1);
		expect(metrics.outputTokens).toBe(42);
		expect(outputTokensOf(messages)).toBe(42);
	});

	it('counts repeated reads of manifest-protected paths', () => {
		const messages = [
			assistantMsg('read snapshot', {
				toolCalls: [
					{ id: 'r1', name: 'read', args: { file_path: '/tmp/flow/review-surface.md' } },
					{ id: 'r2', name: 'read', args: { file_path: '/tmp/flow/review-surface.md' } },
				],
			}),
		];
		const metrics = measureExecutionMetrics(
			makeSingleResult({
				messages,
				readManifest: {
					v: 1,
					manifestPath: '/tmp/read-manifest.json',
					artifactPaths: ['/tmp/flow/review-surface.md'],
					allowedPaths: [],
					priorReports: [],
					establishedEvidence: [],
					doNotReread: ['/tmp/flow/review-surface.md'],
				},
			}),
			Date.now() - 10,
		);
		expect(metrics.manifestRereads).toBe(1);
	});
});
