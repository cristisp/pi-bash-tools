import { describe, expect, it } from 'vitest';
import { buildCompositionTelemetryRecord, buildTelemetryRecord } from '../src/telemetry.ts';
import { makeMetrics, makeSingleResult } from './helpers.ts';

const testCompositionVerdict = (action: 'warn' | 'refuse') => ({
	rule: 'R1' as const,
	action,
	verdict: action === 'warn' ? ('warning' as const) : ('refusal' as const),
	policy: action === 'warn' ? ('warn' as const) : ('enforce' as const),
	mode: 'single' as const,
	agent: 'validator',
	role: 'validator' as const,
	tier: 1,
	reason: 'use the worker verify ref',
	compliantAlternative: 'use the worker verify ref',
});

describe('composition telemetry events', () => {
	it('records warnings as typed boundary events, not failed child turns', () => {
		const record = buildCompositionTelemetryRecord(
			{
				verdicts: [testCompositionVerdict('warn')],
				workspace: 'ws1',
				flowId: 'flow-warning',
				policy: 'warn',
				boundaryId: 'boundary-warning',
			},
			100,
		);
		expect(record).toMatchObject({
			flowId: 'flow-warning',
			event: 'composition',
			compositionBoundaryId: 'boundary-warning',
			compositionBoundaryStatus: 'warning',
			compositionVerdict: { rule: 'R1', action: 'warn', policy: 'warn' },
			outcome: 'settled',
			exitCode: 0,
		});
		expect(record.compositionVerdicts).toBeUndefined();
		expect(record.metrics).toEqual({
			durationMs: 0,
			toolCalls: 0,
			failedToolCalls: 0,
			repeatedReads: 0,
			messageCount: 0,
			taskChars: 0,
			outputChars: 0,
			maxContextTokens: 0,
			turns: 0,
			blockEvents: 0,
			approvalMs: 0,
			steerMs: 0,
		});
	});

	it('records refusals as typed boundary events without fabricating child failure', () => {
		const record = buildCompositionTelemetryRecord(
			{
				verdicts: [testCompositionVerdict('refuse')],
				workspace: 'ws1',
				flowId: 'flow-refusal',
				policy: 'enforce',
				policyOverride: 'enforce',
				boundaryId: 'boundary-refusal',
			},
			100,
		);
		expect(record).toMatchObject({
			flowId: 'flow-refusal',
			event: 'composition',
			compositionBoundaryId: 'boundary-refusal',
			compositionBoundaryStatus: 'refusal',
			compositionPolicy: 'enforce',
			compositionPolicyOverride: 'enforce',
			compositionVerdict: { rule: 'R1', action: 'refuse', policy: 'enforce' },
			outcome: 'settled',
			exitCode: 0,
		});
		expect(record.compositionVerdicts).toBeUndefined();
		expect(record.metrics).toEqual({
			durationMs: 0,
			toolCalls: 0,
			failedToolCalls: 0,
			repeatedReads: 0,
			messageCount: 0,
			taskChars: 0,
			outputChars: 0,
			maxContextTokens: 0,
			turns: 0,
			blockEvents: 0,
			approvalMs: 0,
			steerMs: 0,
		});
	});

	it('omits flow attribution when the parent session is absent', () => {
		const record = buildCompositionTelemetryRecord(
			{
				verdicts: [testCompositionVerdict('warn')],
				workspace: 'ws1',
				policy: 'warn',
			},
			100,
		);
		expect(record.flowId).toBeUndefined();
		expect(record.parentSession).toBeUndefined();
	});
});

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
