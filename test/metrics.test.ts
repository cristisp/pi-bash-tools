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

	it('records failed lookups and preserves producer freshness fields', () => {
		const messages = [
			assistantMsg('lookup and execute', {
				toolCalls: [
					{
						id: 'missing',
						name: 'verify',
						args: { ref: 'vr_missing', flowId: 'f1', covers: ['AC-001'] },
					},
					{ id: 'fresh', name: 'verify', args: { fresh: true, publish: { flowId: 'f1' } } },
				],
			}),
			{
				...toolResultMsg(
					'missing',
					JSON.stringify({ code: 'NOT_FOUND', message: 'ref not found' }),
					'verify',
				),
				isError: true,
			},
			toolResultMsg(
				'fresh',
				JSON.stringify({
					ref: 'vr_fresh',
					verdict: 'passed',
					reused: false,
					repositoryStateStatus: 'mismatch',
					stateDrift: true,
					concurrentExecutions: 2,
					mutating: false,
					forced: true,
					perStep: { format: { status: 'passed' }, lint: { status: 'omitted' } },
				}),
				'verify',
			),
		];
		const metrics = measureExecutionMetrics(makeSingleResult({ messages }), Date.now() - 5);

		expect(metrics.fullValidationPasses).toBe(1);
		expect(metrics.lookupFailures).toEqual([
			{ ref: 'vr_missing', errorClass: 'not-found', message: 'ref not found' },
		]);
		expect(metrics.validationRefs?.[0]).toMatchObject({
			ref: 'vr_fresh',
			verdict: 'incomplete',
			repositoryStateStatus: 'mismatch',
			stateDrift: true,
			concurrentExecutions: 2,
			forced: true,
			omitted: ['lint'],
		});
		expect(metrics.validationExecutions).toEqual([
			{
				tool: 'verify',
				stateDrift: true,
				concurrentExecutions: 2,
				mutating: false,
				forced: true,
			},
		]);
	});

	it('preserves producer decisions and provenance for hits, forced runs, and denied lookups', () => {
		const messages = [
			assistantMsg('producer metadata', {
				toolCalls: [
					{
						id: 'hit',
						name: 'verify',
						args: { ref: 'vr_hit', flowId: 'flow-hit', covers: ['AC-009'] },
					},
					{ id: 'forced', name: 'verify', args: { fresh: true } },
					{
						id: 'denied',
						name: 'verify',
						args: { ref: 'vr_denied', flowId: 'flow-requested', covers: ['AC-009'] },
					},
				],
			}),
			toolResultMsg(
				'hit',
				JSON.stringify({
					ref: 'vr_hit',
					verdict: 'passed',
					reused: true,
					decision: 'hit',
					cacheDecision: 'reused',
					provenance: { flowId: 'flow-hit' },
					producerScope: 'scope-is-not-a-flow-id',
				}),
				'verify',
			),
			toolResultMsg(
				'forced',
				JSON.stringify({
					ref: 'vr_forced',
					verdict: 'passed',
					reused: false,
					execution: {
						decision: 'forced',
						cacheDecision: 'miss',
						publication: { flowId: 'flow-forced' },
					},
					producerScope: 'scope-is-not-a-flow-id',
				}),
				'verify',
			),
			{
				...toolResultMsg(
					'denied',
					JSON.stringify({
						code: 'FORBIDDEN',
						message: 'flow provenance denied',
						error: 'permission denied',
						decision: 'denied',
						cacheDecision: 'miss',
						publication: { flowId: 'flow-requested' },
						producerScope: 'scope-is-not-a-flow-id',
					}),
					'verify',
				),
				isError: true,
			},
		];
		const metrics = measureExecutionMetrics(makeSingleResult({ messages }), Date.now() - 5);

		expect(metrics.validationRefs).toEqual([
			expect.objectContaining({
				ref: 'vr_hit',
				decision: 'hit',
				cacheDecision: 'reused',
				flowId: 'flow-hit',
			}),
			expect.objectContaining({
				ref: 'vr_forced',
				forced: true,
				decision: 'forced',
				cacheDecision: 'miss',
				flowId: 'flow-forced',
			}),
		]);
		expect(metrics.validationExecutions).toEqual([
			expect.objectContaining({
				tool: 'verify',
				forced: true,
				decision: 'forced',
				cacheDecision: 'miss',
				flowId: 'flow-forced',
			}),
		]);
		expect(metrics.lookupFailures).toEqual([
			{
				ref: 'vr_denied',
				errorClass: 'denied',
				message: 'flow provenance denied',
				decision: 'denied',
				cacheDecision: 'miss',
				flowId: 'flow-requested',
			},
		]);
	});

	it('fails closed when producer flow provenance conflicts', () => {
		const messages = [
			assistantMsg('conflicting producer provenance', {
				toolCalls: [
					{ id: 'direct-provenance', name: 'verify', args: { ref: 'vr_direct_provenance' } },
					{ id: 'direct-publication', name: 'verify', args: { ref: 'vr_direct_publication' } },
					{ id: 'nested', name: 'verify', args: { fresh: true } },
					{ id: 'lookup', name: 'verify', args: { ref: 'vr_lookup' } },
				],
			}),
			toolResultMsg(
				'direct-provenance',
				JSON.stringify({
					ref: 'vr_direct_provenance',
					verdict: 'passed',
					reused: true,
					flowId: 'flow-direct',
					provenance: { flowId: 'flow-provenance' },
				}),
				'verify',
			),
			toolResultMsg(
				'direct-publication',
				JSON.stringify({
					ref: 'vr_direct_publication',
					verdict: 'passed',
					reused: true,
					flowId: 'flow-direct',
					publication: { flowId: 'flow-publication' },
				}),
				'verify',
			),
			toolResultMsg(
				'nested',
				JSON.stringify({
					ref: 'vr_nested',
					verdict: 'passed',
					reused: false,
					provenance: { flowId: 'flow-nested-provenance' },
					publication: { flowId: 'flow-nested-publication' },
				}),
				'verify',
			),
			{
				...toolResultMsg(
					'lookup',
					JSON.stringify({
						code: 'FORBIDDEN',
						message: 'conflicting flow provenance denied',
						provenance: { flowId: 'flow-lookup-provenance' },
						publication: { flowId: 'flow-lookup-publication' },
					}),
					'verify',
				),
				isError: true,
			},
		];
		const metrics = measureExecutionMetrics(makeSingleResult({ messages }), Date.now() - 5);

		expect(metrics.validationRefs).toHaveLength(3);
		for (const reference of metrics.validationRefs ?? []) {
			expect(reference.flowIdConflict).toBe(true);
			expect(reference).not.toHaveProperty('flowId');
		}
		expect(metrics.validationExecutions).toEqual([
			expect.objectContaining({ tool: 'verify', flowIdConflict: true }),
		]);
		expect(metrics.validationExecutions?.[0]).not.toHaveProperty('flowId');
		expect(metrics.lookupFailures).toEqual([
			expect.objectContaining({
				errorClass: 'denied',
				flowIdConflict: true,
			}),
		]);
		expect(metrics.lookupFailures?.[0]).not.toHaveProperty('flowId');
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
