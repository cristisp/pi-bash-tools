import { describe, expect, it } from 'vitest';
import { buildTelemetryRecord } from '../src/telemetry.ts';
import { makeMetrics, makeSingleResult } from './helpers.ts';

describe('buildTelemetryRecord', () => {
	it('keeps explicit root and parent-pane attribution with budget data', () => {
		const result = makeSingleResult({
			budget: {
				role: 'worker',
				limits: {
					toolCalls: 2,
					discoveryCalls: 2,
					fullValidationPasses: 1,
					failedToolCalls: 1,
					repeatedReads: 1,
					outputTokens: 100,
					wallTimeMs: 1000,
					budgetPolicy: 'steer',
				},
				usage: {
					toolCalls: 3,
					discoveryCalls: 0,
					fullValidationPasses: 0,
					failedToolCalls: 0,
					repeatedReads: 0,
					outputTokens: 0,
					wallTimeMs: 10,
				},
				outcome: 'steered',
				breaches: [],
				steerIssued: true,
				reportOnly: true,
			},
		});
		const record = buildTelemetryRecord({
			delegation: {
				delegationId: 'delegation-1',
				role: 'worker',
				evidenceScope: 'flow',
				rootSession: '/tmp/root.jsonl',
				parentPaneId: 'ws1:p0',
				tier: 2,
			},
			workspace: 'ws1',
			label: 'worker-1',
			agent: 'worker',
			reused: true,
			reuseCount: 1,
			outcome: 'settled',
			parentSession: '/tmp/root.jsonl',
			result: {
				...result,
				metrics: makeMetrics(),
				readManifest: {
					v: 1,
					persistedPath: '/tmp/read-manifest.json',
					artifactPaths: ['/tmp/review-surface.md'],
					allowedPaths: ['src/run.ts'],
					priorReports: [],
					establishedEvidence: ['snapshot'],
					doNotReread: ['/tmp/review-surface.md'],
				},
			},
		});

		expect(record.rootSession).toBe('/tmp/root.jsonl');
		expect(record.parentPaneId).toBe('ws1:p0');
		expect(record.budget?.outcome).toBe('steered');
		expect(record.reused).toBe(true);
		expect(record.readManifest?.persistedPath).toBe('/tmp/read-manifest.json');
	});
});
