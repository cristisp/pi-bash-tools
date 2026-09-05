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
		expect(metrics.reportOutputTokens).toBe(0);
		expect(outputTokensOf(messages)).toBe(42);
	});

	it('records tool-issued verify refs, which call executed, and the minted state', () => {
		const minted = {
			status: 'completed',
			verdict: 'passed',
			ref: 'vr_aaa',
			reused: false,
			repositoryState: {
				head: 'deadbeefcafe1234',
				dirtyFilesDigest: 'ab12cd34ef56ab78',
				workingDirectory: '/repo',
			},
		};
		const messages = [
			assistantMsg('validating', {
				toolCalls: [{ id: 'v1', name: 'verify', args: {} }],
			}),
			toolResultMsg('v1', JSON.stringify(minted), 'verify'),
			assistantMsg('resolving', {
				toolCalls: [{ id: 'v2', name: 'verify', args: { ref: 'vr_aaa' } }],
			}),
			toolResultMsg(
				'v2',
				JSON.stringify({ ...minted, status: 'unchanged', reused: true }),
				'verify',
			),
			assistantMsg('other tool', {
				toolCalls: [{ id: 'b1', name: 'bash', args: { command: 'true' } }],
			}),
			toolResultMsg('b1', JSON.stringify({ ref: 'vr_not_a_verify_ref' }), 'bash'),
		];
		const metrics = measureExecutionMetrics(makeSingleResult({ messages }), Date.now() - 5);

		expect(metrics.fullValidationPasses).toBe(1);
		expect(metrics.validationRefs).toEqual([
			{
				ref: 'vr_aaa',
				verdict: 'passed',
				reused: false,
				lookup: false,
				head: 'deadbeefcafe',
				stateDigest: 'ab12cd34ef56',
			},
			{
				ref: 'vr_aaa',
				verdict: 'passed',
				reused: true,
				lookup: true,
				head: 'deadbeefcafe',
				stateDigest: 'ab12cd34ef56',
			},
		]);
	});

	it('separates report prose from output spent on tool arguments', () => {
		const messages = [
			assistantMsg('reading', {
				usage: { output: 30 },
				toolCalls: [{ id: 'r1', name: 'read', args: { path: 'src/a.ts' } }],
			}),
			assistantMsg('the findings', { usage: { output: 12 } }),
		];
		const metrics = measureExecutionMetrics(makeSingleResult({ messages }), Date.now() - 5);

		expect(metrics.outputTokens).toBe(42);
		expect(metrics.reportOutputTokens).toBe(12);
		expect(metrics.toolArgumentOutputTokens).toBe(30);
		expect(metrics.reasoningTokens).toBe(0);
	});

	it('excludes reasoning tokens from the report budget', () => {
		const messages = [
			assistantMsg('thinking hard', {
				usage: { output: 3_400, reasoning: 3_300 },
				toolCalls: [{ id: 'r1', name: 'read', args: { path: 'src/a.ts' } }],
			}),
			assistantMsg('the findings', { usage: { output: 6_277, reasoning: 4_138 } }),
		];
		const metrics = measureExecutionMetrics(makeSingleResult({ messages }), Date.now() - 5);

		expect(metrics.reportOutputTokens).toBe(2_139);
		expect(metrics.reasoningTokens).toBe(4_138);
		expect(metrics.toolArgumentOutputTokens).toBe(3_400);
		expect(metrics.outputTokens).toBe(9_677);
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
