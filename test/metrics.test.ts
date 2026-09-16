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
				lookupOutcome: 'success',
				head: 'deadbeefcafe',
				stateDigest: 'ab12cd34ef56',
			},
		]);
	});

	it('reads the shared workspace envelope block as the primary freshness input', () => {
		const messages = [
			assistantMsg('validating', {
				toolCalls: [
					{ id: 'v1', name: 'verify', args: {} },
					{ id: 'v2', name: 'verify', args: {} },
					{ id: 'v3', name: 'verify', args: {} },
				],
			}),
			toolResultMsg(
				'v1',
				JSON.stringify({
					ref: 'vr_env',
					verdict: 'passed',
					reused: true,
					workspace: {
						repositoryId: 'a'.repeat(64),
						head: 'feedface0001feedface0002',
						dirtyDigest: '9988776655443322',
						status: 'readable',
					},
				}),
				'verify',
			),
			toolResultMsg(
				'v2',
				JSON.stringify({
					ref: 'vr_env_wins',
					verdict: 'passed',
					reused: true,
					repositoryState: {
						head: 'deadbeefcafe1234',
						dirtyFilesDigest: 'ab12cd34ef56ab78',
					},
					workspace: {
						repositoryId: 'a'.repeat(64),
						head: 'feedface0001feedface0002',
						dirtyDigest: '9988776655443322',
						status: 'readable',
					},
				}),
				'verify',
			),
			toolResultMsg(
				'v3',
				JSON.stringify({
					ref: 'vr_degraded',
					verdict: 'passed',
					reused: true,
					repositoryState: {
						head: 'deadbeefcafe1234',
						dirtyFilesDigest: 'ab12cd34ef56ab78',
					},
					workspace: {
						repositoryId: 'a'.repeat(64),
						head: 'feedface0001feedface0002',
						dirtyDigest: null,
						status: 'degraded',
					},
				}),
				'verify',
			),
		];
		const metrics = measureExecutionMetrics(makeSingleResult({ messages }), Date.now() - 10);

		expect(metrics.validationRefs?.[0]).toMatchObject({
			ref: 'vr_env',
			head: 'feedface0001',
			stateDigest: '998877665544',
		});
		expect(metrics.validationRefs?.[1]).toMatchObject({
			ref: 'vr_env_wins',
			head: 'feedface0001',
			stateDigest: '998877665544',
		});
		expect(metrics.validationRefs?.[2]).toMatchObject({
			ref: 'vr_degraded',
			repositoryStateStatus: 'unreadable',
			head: 'deadbeefcafe',
			stateDigest: 'ab12cd34ef56',
		});
	});

	it('falls back to producer detail fields on a malformed workspace block and keeps explicit status', () => {
		const messages = [
			assistantMsg('validating', {
				toolCalls: [
					{ id: 'v1', name: 'verify', args: {} },
					{ id: 'v2', name: 'verify', args: {} },
				],
			}),
			toolResultMsg(
				'v1',
				JSON.stringify({
					ref: 'vr_bad',
					verdict: 'passed',
					reused: true,
					repositoryState: {
						head: 'deadbeefcafe1234',
						dirtyFilesDigest: 'ab12cd34ef56ab78',
					},
					workspace: { repositoryId: 'a'.repeat(64), head: 42, status: 'partial' },
				}),
				'verify',
			),
			toolResultMsg(
				'v2',
				JSON.stringify({
					ref: 'vr_explicit',
					verdict: 'passed',
					reused: true,
					repositoryStateStatus: 'mismatch',
					workspace: {
						repositoryId: 'a'.repeat(64),
						head: 'feedface0001feedface0002',
						dirtyDigest: '9988776655443322',
						status: 'degraded',
					},
				}),
				'verify',
			),
		];
		const metrics = measureExecutionMetrics(makeSingleResult({ messages }), Date.now() - 10);

		expect(metrics.validationRefs?.[0]).toMatchObject({
			ref: 'vr_bad',
			head: 'deadbeefcafe',
			stateDigest: 'ab12cd34ef56',
		});
		expect(metrics.validationRefs?.[0]?.repositoryStateStatus).toBeUndefined();
		expect(metrics.validationRefs?.[1]).toMatchObject({
			ref: 'vr_explicit',
			repositoryStateStatus: 'mismatch',
		});
		expect(metrics.validationRefs?.[1]?.head).toBeUndefined();
		expect(metrics.validationRefs?.[1]?.stateDigest).toBeUndefined();
	});

	it('normalizes publication outcomes from both producer vocabularies', () => {
		const publicationCases: Record<string, unknown>[] = [
			{ state: 'published', ref: 'cg_fresh', reason: null },
			{ state: 'unauthorized', ref: null, reason: null },
			{ state: 'failed', ref: null, reason: 'store write rejected' },
			{ scope: 'flow', flowId: 'f1', published: true },
			{
				scope: 'flow',
				flowId: 'f1',
				published: false,
				error: 'Evidence publication was  not\navailable.',
			},
			{ status: 'wat' },
		];
		const messages = [
			assistantMsg('validating', {
				toolCalls: publicationCases.map((_, index) => ({
					id: `v${index}`,
					name: 'verify',
					args: {},
				})),
			}),
			...publicationCases.map((publication, index) =>
				toolResultMsg(
					`v${index}`,
					JSON.stringify({
						ref: `vr_pub_${index}`,
						verdict: 'passed',
						reused: false,
						publication,
					}),
					'verify',
				),
			),
		];
		const metrics = measureExecutionMetrics(makeSingleResult({ messages }), Date.now() - 10);

		expect(metrics.validationRefs?.[0]).toMatchObject({
			ref: 'vr_pub_0',
			publication: 'published',
		});
		expect(metrics.validationRefs?.[1]).toMatchObject({
			ref: 'vr_pub_1',
			publication: 'unauthorized',
		});
		expect(metrics.validationRefs?.[2]).toMatchObject({
			ref: 'vr_pub_2',
			publication: 'failed',
			publicationReason: 'store write rejected',
		});
		expect(metrics.validationRefs?.[3]).toMatchObject({
			ref: 'vr_pub_3',
			publication: 'published',
		});
		expect(metrics.validationRefs?.[4]).toMatchObject({
			ref: 'vr_pub_4',
			publication: 'failed',
			publicationReason: 'Evidence publication was not available.',
		});
		expect(metrics.validationRefs?.[5]?.publication).toBeUndefined();
		expect(metrics.validationRefs?.[5]?.publicationReason).toBeUndefined();
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
				ref: 'vr_fresh',
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

	describe('read_batch evidence refs', () => {
		it('captures minted refs with publication provenance and unchanged flags', () => {
			const messages = [
				assistantMsg('batching reads', {
					toolCalls: [{ id: 'rb1', name: 'read_batch', args: { paths: [] } }],
				}),
				{
					...toolResultMsg('rb1', 'ok', 'read_batch'),
					details: {
						results: [
							{ path: 'src/a.ts', unchanged: false, ref: 'rr_fresh', contentHash: 'aa11' },
							{ path: 'src/b.ts', unchanged: true, ref: 'rr_repeat', contentHash: 'bb22' },
							{ path: 'src/c.ts', error: { code: 'outside-repository' } },
						],
						publish: { scope: 'flow', flowId: 'flow-reads', published: true },
					},
				},
			];
			const metrics = measureExecutionMetrics(makeSingleResult({ messages }), Date.now() - 5);

			expect(metrics.readRefs).toEqual([
				{ ref: 'rr_fresh', reused: false, publication: 'published', flowId: 'flow-reads' },
				{ ref: 'rr_repeat', reused: true, publication: 'published', flowId: 'flow-reads' },
			]);
		});

		it('records failed publication provenance on read refs', () => {
			const messages = [
				assistantMsg('batching reads', {
					toolCalls: [{ id: 'rb1', name: 'read_batch', args: { paths: [] } }],
				}),
				{
					...toolResultMsg('rb1', 'ok', 'read_batch'),
					details: {
						results: [{ path: 'src/a.ts', unchanged: false, ref: 'rr_unpublished' }],
						publish: { scope: 'flow', flowId: 'flow-reads', published: false, error: 'denied' },
					},
				},
			];
			const metrics = measureExecutionMetrics(makeSingleResult({ messages }), Date.now() - 5);

			expect(metrics.readRefs).toEqual([
				{
					ref: 'rr_unpublished',
					reused: false,
					publication: 'failed',
					publicationReason: 'denied',
					flowId: 'flow-reads',
				},
			]);
		});

		it('captures a confirmed ref from a successful read_batch lookup', () => {
			const messages = [
				assistantMsg('confirming a known ref', {
					toolCalls: [{ id: 'rb2', name: 'read_batch', args: { ref: 'rr_known' } }],
				}),
				{
					...toolResultMsg('rb2', 'ok', 'read_batch'),
					details: {
						results: [],
						lookup: {
							ref: 'rr_known',
							executed: false,
							repositoryStateStatus: 'matches',
							entries: [{ path: 'src/a.ts', status: 'unchanged' }],
						},
					},
				},
			];
			const metrics = measureExecutionMetrics(makeSingleResult({ messages }), Date.now() - 5);

			expect(metrics.readRefs).toEqual([
				{ ref: 'rr_known', reused: true, lookup: true, repositoryStateStatus: 'matches' },
			]);
			expect(metrics.codegraphIndex).toBeUndefined();
		});

		it('records failed read_batch lookups as lookup failures', () => {
			const messages = [
				assistantMsg('confirming a missing ref', {
					toolCalls: [{ id: 'rb3', name: 'read_batch', args: { ref: 'rr_missing' } }],
				}),
				{
					...toolResultMsg(
						'rb3',
						'read ref rr_missing not found in the effective flow scope flow-reads',
						'read_batch',
					),
					isError: true,
				},
			];
			const metrics = measureExecutionMetrics(makeSingleResult({ messages }), Date.now() - 5);

			expect(metrics.lookupFailures).toEqual([
				{ ref: 'rr_missing', errorClass: 'not-found', message: expect.any(String) },
			]);
			expect(metrics.readRefs).toBeUndefined();
		});

		it('caps captured read refs per turn', () => {
			const items = Array.from({ length: 30 }, (_, index) => ({
				path: `src/f${index}.ts`,
				unchanged: false,
				ref: `rr_${index}`,
			}));
			const messages = [
				assistantMsg('batching reads', {
					toolCalls: [{ id: 'rb4', name: 'read_batch', args: { paths: [] } }],
				}),
				{ ...toolResultMsg('rb4', 'ok', 'read_batch'), details: { results: items } },
			];
			const metrics = measureExecutionMetrics(makeSingleResult({ messages }), Date.now() - 5);

			expect(metrics.readRefs).toHaveLength(24);
			expect(metrics.readRefs?.[0]).toMatchObject({ ref: 'rr_0' });
		});
	});

	it('marks verify lookup refs with the structured or implicit lookup outcome', () => {
		const messages = [
			assistantMsg('resolving', {
				toolCalls: [
					{ id: 'v1', name: 'verify', args: { ref: 'vr_hit' } },
					{ id: 'v2', name: 'verify', args: { ref: 'vr_hit2' } },
				],
			}),
			toolResultMsg(
				'v1',
				JSON.stringify({
					ref: 'vr_hit',
					verdict: 'passed',
					reused: true,
					lookup: { attempted: true, success: true, outcome: 'success' },
				}),
				'verify',
			),
			toolResultMsg(
				'v2',
				JSON.stringify({ ref: 'vr_hit2', verdict: 'passed', reused: true }),
				'verify',
			),
		];
		const metrics = measureExecutionMetrics(makeSingleResult({ messages }), Date.now() - 5);

		expect(metrics.validationRefs?.[0]).toMatchObject({
			ref: 'vr_hit',
			lookup: true,
			lookupOutcome: 'success',
		});
		expect(metrics.validationRefs?.[1]).toMatchObject({ ref: 'vr_hit2', lookupOutcome: 'success' });
	});

	it('captures codegraph producer index states with distinct ids', () => {
		const messages = [
			assistantMsg('exploring', {
				toolCalls: [{ id: 'cg1', name: 'codegraph_explore', args: { query: 'q' } }],
			}),
			{
				...toolResultMsg('cg1', 'ok', 'codegraph_explore'),
				details: { producerState: { indexId: 'idx-1' } },
			},
			{
				...toolResultMsg('cg1', 'ok', 'codegraph_explore'),
				details: { producerState: { indexId: 'idx-1' } },
			},
			{
				...toolResultMsg('cg1', 'ok', 'codegraph_explore'),
				details: { producerState: { indexId: 'idx-2' } },
			},
			{ ...toolResultMsg('cg1', 'ok', 'codegraph_explore'), details: {} },
		];
		const metrics = measureExecutionMetrics(makeSingleResult({ messages }), Date.now() - 5);

		expect(metrics.codegraphIndex).toEqual({ results: 3, indexIds: ['idx-1', 'idx-2'] });
	});
});
