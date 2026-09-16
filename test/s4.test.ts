import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeS4, renderS4Markdown } from '../analysis/measure.ts';
import { normalizeS4Outcome, normalizeS4Quality } from '../src/report.ts';
import type { S4Outcome, S4Preflight, S4QualitySignals, TelemetryRecord } from '../src/types.ts';

const DAY_MS = 86_400_000;

function base(overrides: Record<string, unknown> = {}): TelemetryRecord {
	return {
		v: 1,
		at: 100,
		delegationId: 'record',
		flowId: 'flow-1',
		taskId: 'task-1',
		workspace: 'workspace',
		label: 's4',
		agent: 'worker',
		role: 'worker',
		evidenceScope: 'flow',
		reused: false,
		reuseCount: 0,
		outcome: 'settled',
		exitCode: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		metrics: {
			durationMs: 1,
			toolCalls: 1,
			failedToolCalls: 0,
			repeatedReads: 0,
			messageCount: 1,
			taskChars: 1,
			outputChars: 1,
			maxContextTokens: 1,
			turns: 1,
			blockEvents: 0,
			approvalMs: 0,
			steerMs: 0,
		},
		...overrides,
	} as TelemetryRecord;
}

function qualitySignals(overrides: Partial<S4QualitySignals> = {}): S4QualitySignals {
	return {
		unresolvedOrAbandoned: false,
		reviewerPass: null,
		regressionAfterReviewPass: false,
		tier1DiscoveryFailure: false,
		independentReviewStatus: 'unknown',
		escalation: { fromTier: 1, toTier: 1, direction: 'same' },
		componentStatusConsistent: true,
		...overrides,
	};
}

function preflight(
	options: {
		at?: number;
		boundary?: string;
		flowId?: string;
		taskId?: string;
		mode?: 'single' | 'parallel' | 'chain';
		expectedChildCount?: number;
		eligibleRule?: 'R1' | 'R2' | 'R3' | 'R4';
		policy?: 'warn' | 'enforce' | 'off';
		observations?: S4Preflight['observations'];
	} = {},
): TelemetryRecord {
	const boundary = options.boundary ?? 'boundary-1';
	const flowId = options.flowId ?? 'flow-1';
	const taskId = options.taskId ?? 'task-1';
	const mode = options.mode ?? 'chain';
	const expectedChildCount = options.expectedChildCount ?? 1;
	const eligibleRule = options.eligibleRule ?? 'R4';
	const policy = options.policy ?? 'warn';
	const observations =
		options.observations ??
		(['R1', 'R2', 'R3', 'R4'] as const).map((ruleId) => ({
			ruleId,
			eligible: ruleId === eligibleRule,
			compliant: ruleId === eligibleRule ? true : null,
			action: ruleId === eligibleRule ? ('allow' as const) : ('not_applicable' as const),
			decisionSource: 'default' as const,
			reason:
				ruleId === eligibleRule
					? `eligible ${ruleId} candidate`
					: `no eligible ${ruleId} candidate`,
			compositionBoundaryId: boundary,
			mode,
			policy,
			expectedChildCount,
		}));
	const value: S4Preflight = {
		v: 1,
		compositionBoundaryId: boundary,
		mode,
		policy,
		expectedChildCount,
		observations,
	};
	return base({
		at: options.at ?? 100,
		flowId,
		taskId,
		event: 's4_preflight',
		compositionBoundaryId: boundary,
		s4Preflight: value,
	});
}

function outcome(
	options: {
		at?: number;
		boundary?: string;
		flowId?: string;
		taskId?: string;
		delegationId?: string;
		ledgerRevision?: number;
		role?: string;
		quality?: S4Outcome['quality'];
		independentReviewStatus?: S4Outcome['independentReviewStatus'];
		qualitySignals?: Partial<S4QualitySignals>;
	} = {},
): TelemetryRecord {
	const boundary = options.boundary ?? 'boundary-1';
	const flowId = options.flowId ?? 'flow-1';
	const taskId = options.taskId ?? 'task-1';
	const role = options.role ?? 'worker';
	const independentReviewStatus = options.independentReviewStatus ?? 'unknown';
	const value: S4Outcome = {
		v: 1,
		lifecycle: 'settled',
		quality: options.quality ?? 'pass',
		validationStatus: 'pass',
		reviewStatus: role === 'reviewer' ? 'pass' : 'not_run',
		budgetStatus: 'pass',
		independentReviewStatus,
		qualitySignals: qualitySignals({
			reviewerPass: role === 'reviewer',
			independentReviewStatus: role === 'reviewer' ? independentReviewStatus : 'unknown',
			...options.qualitySignals,
		}),
		correlation: {
			flowId,
			taskId,
			delegationId: options.delegationId ?? `${taskId}-child`,
			ledgerRevision: options.ledgerRevision ?? 2,
			compositionBoundaryId: boundary,
		},
	};
	return base({
		at: options.at ?? 100,
		flowId,
		taskId,
		role,
		delegationId: value.correlation.delegationId,
		event: 's4_outcome',
		compositionBoundaryId: boundary,
		ledgerRevision: value.correlation.ledgerRevision,
		s4Outcome: value,
	});
}

function representativeRecords(): TelemetryRecord[] {
	const records: TelemetryRecord[] = [];
	const rules = ['R1', 'R1', 'R2', 'R2', 'R3', 'R3', 'R4', 'R4'] as const;
	for (let index = 0; index < rules.length; index++) {
		const rule = rules[index];
		const boundary = `boundary-${index}`;
		const flowId = `flow-${index}`;
		const taskId = `task-${index}`;
		const mode = rule === 'R2' ? 'parallel' : 'chain';
		const expectedChildCount = rule === 'R2' ? 2 : 1;
		const preflightRecord = preflight({
			at: index * DAY_MS,
			boundary,
			flowId,
			taskId,
			mode,
			expectedChildCount,
			eligibleRule: rule,
		});
		records.push(preflightRecord);
		for (let child = 0; child < expectedChildCount; child++) {
			records.push(
				outcome({
					at: index * DAY_MS,
					boundary,
					flowId,
					taskId,
					delegationId: `${taskId}-child-${child}`,
					role:
						rule === 'R2' ? 'reviewer' : rule === 'R1' || rule === 'R3' ? 'validator' : 'worker',
					independentReviewStatus: rule === 'R2' ? 'pass' : 'unknown',
				}),
			);
		}
	}
	return records;
}

describe('S4 quality normalization', () => {
	it('uses strict vocabulary and preserves not-run versus unknown', () => {
		expect(normalizeS4Quality('PASS')).toBe('pass');
		expect(normalizeS4Quality('none')).toBe('not_run');
		expect(normalizeS4Quality('future-status')).toBe('unknown');
		expect(
			normalizeS4Outcome(
				{
					validation_verdict: 'PASS',
					review_verdict: 'none',
					unresolved_questions: 'none',
					delegation_status: 'settled',
				},
				'worker',
				{ ledgerParsed: true } as never,
				{ outcome: 'within' } as never,
			),
		).toMatchObject({ quality: 'pass', validationStatus: 'pass', reviewStatus: 'not_run' });
	});

	it('does not pass findings, omitted evidence, or missing signals', () => {
		expect(
			normalizeS4Outcome(
				{
					validation_verdict: 'PASS',
					review_verdict: 'none',
					findings: 'F-1',
					delegation_status: 'settled',
				},
				'worker',
				undefined,
				{ outcome: 'within' } as never,
			).quality,
		).toBe('incomplete');
		expect(normalizeS4Outcome(undefined, 'worker').quality).toBe('incomplete');
	});

	it('requires an explicit independent review handoff', () => {
		const fields = {
			validation_verdict: 'PASS',
			review_verdict: 'PASS',
			unresolved_questions: 'none',
			delegation_status: 'settled',
		};
		expect(
			normalizeS4Outcome(
				fields,
				'reviewer',
				{ ledgerParsed: true } as never,
				{ outcome: 'within' } as never,
			),
		).toMatchObject({ quality: 'pass', independentReviewStatus: 'pending' });
		expect(
			normalizeS4Outcome(
				{ ...fields, independent_review_handoff: 'true', independent_review_status: 'pass' },
				'reviewer',
				{ ledgerParsed: true } as never,
				{ outcome: 'within' } as never,
			),
		).toMatchObject({ independentReviewStatus: 'pass' });
	});

	it('does not treat reviewer findings or baseline failures as unresolved blockers', () => {
		expect(
			normalizeS4Outcome(
				{
					validation_verdict: 'PASS',
					review_verdict: 'none',
					findings: 'F-1: narrow scope',
					baseline_failures: 'no baseline failures',
					unresolved_questions: 'None.',
					environment_blockers: 'No blockers.',
					delegation_status: 'settled',
				},
				'reviewer',
				{ ledgerParsed: true } as never,
				{ outcome: 'within' } as never,
			),
		).toMatchObject({
			quality: 'incomplete',
			qualitySignals: { unresolvedOrAbandoned: false },
		});
		expect(
			normalizeS4Outcome(
				{
					validation_verdict: 'PASS',
					review_verdict: 'PASS',
					findings: 'F-1',
					unresolved_questions: 'none',
					environment_blockers: 'registry entry missing for worker-2',
					delegation_status: 'settled',
				},
				'reviewer',
				{ ledgerParsed: true } as never,
				{ outcome: 'within' } as never,
			),
		).toMatchObject({ quality: 'incomplete', qualitySignals: { unresolvedOrAbandoned: true } });
	});

	it('does not mark non-settled lifecycles as passing quality', () => {
		const fields = {
			validation_verdict: 'PASS',
			review_verdict: 'none',
			unresolved_questions: 'none',
		};
		for (const lifecycle of ['failed', 'aborted', 'blocked'] as const)
			expect(
				normalizeS4Outcome(
					fields,
					'worker',
					{ ledgerParsed: true } as never,
					{ outcome: 'within' } as never,
					lifecycle,
				),
			).not.toMatchObject({ quality: 'pass' });
	});
});

describe('S4 analyzer', () => {
	it('passes complete correlated evidence and renders a machine-readable decision', () => {
		const decision = analyzeS4(representativeRecords(), { independentReview: 'pass' });
		expect(decision).toMatchObject({
			status: 'ENFORCE_CANDIDATE',
			decision: 'pass',
			preflights: 8,
			boundaries: 8,
		});
		expect(renderS4Markdown(decision)).toContain('Decision (legacy alias): **pass**');
	});

	it('does not treat an ordinary reviewer pass as independent review', () => {
		const records = representativeRecords();
		for (const record of records) {
			if (record.role !== 'reviewer' || !record.s4Outcome) continue;
			record.s4Outcome.independentReviewStatus = 'unknown';
			record.s4Outcome.qualitySignals.independentReviewStatus = 'unknown';
		}
		const decision = analyzeS4(records);
		expect(decision.independentReview.status).toBe('insufficient');
	});

	it('requires real R2 eligibility and fails noncompliant eligible rules', () => {
		const records = representativeRecords();
		const invalidR2 = records.find((record) =>
			record.s4Preflight?.observations.some(
				(observation) => observation.ruleId === 'R2' && observation.eligible,
			),
		);
		expect(invalidR2?.s4Preflight).toBeDefined();
		invalidR2!.s4Preflight!.mode = 'chain';
		expect(analyzeS4(records, { independentReview: 'pass' }).status).toBe('INSUFFICIENT_EVIDENCE');

		const noncompliant = representativeRecords();
		const candidate = noncompliant.find((record) =>
			record.s4Preflight?.observations.some(
				(observation) => observation.ruleId === 'R4' && observation.eligible,
			),
		);
		const observation = candidate!.s4Preflight!.observations.find((item) => item.ruleId === 'R4')!;
		observation.compliant = false;
		expect(analyzeS4(noncompliant, { independentReview: 'pass' }).status).toBe('RETAIN_WARN');
	});

	it('counts tier 1 discovery failures only from explicit signals', () => {
		const records = representativeRecords();
		const workerOutcomes = records.filter(
			(record) => record.event === 's4_outcome' && record.role === 'worker',
		);
		for (const record of workerOutcomes) record.tier = 1;
		const explicit = analyzeS4(records, { independentReview: 'pass' });
		expect(explicit.guardrails.tier1DiscoveryFailure).toMatchObject({
			numerator: 0,
			denominator: workerOutcomes.length,
			status: 'pass',
		});

		const failing = representativeRecords();
		for (const worker of failing.filter(
			(record) => record.event === 's4_outcome' && record.role === 'worker',
		))
			worker.tier = 1;
		const failingOutcome = failing.find(
			(record) => record.event === 's4_outcome' && record.role === 'worker',
		)!;
		failingOutcome.s4Outcome!.qualitySignals.tier1DiscoveryFailure = true;
		expect(
			analyzeS4(failing, { independentReview: 'pass' }).guardrails.tier1DiscoveryFailure,
		).toMatchObject({ numerator: 1, denominator: 2, status: 'fail' });

		const unreported = representativeRecords();
		for (const worker of unreported.filter(
			(record) => record.event === 's4_outcome' && record.role === 'worker',
		)) {
			worker.tier = 1;
			worker.s4Outcome!.qualitySignals.tier1DiscoveryFailure = null;
		}
		expect(
			analyzeS4(unreported, { independentReview: 'pass' }).guardrails.tier1DiscoveryFailure,
		).toMatchObject({ numerator: 0, denominator: 2, status: 'unknown' });
	});

	it('names the defect for every rejected outcome', () => {
		const malformed = representativeRecords();
		const malformedOutcome = malformed.find((record) => record.event === 's4_outcome')!;
		malformedOutcome.s4Outcome!.correlation.flowId = 'other-flow';
		const decision = analyzeS4(malformed, { independentReview: 'pass' });
		expect(decision.reasons.join('\n')).toContain(
			'rejected: record fields disagree with the outcome correlation',
		);

		const unreported = representativeRecords();
		const unreportedOutcome = unreported.find((record) => record.event === 's4_outcome')!;
		unreportedOutcome.s4Outcome!.qualitySignals.unresolvedOrAbandoned = null;
		expect(analyzeS4(unreported, { independentReview: 'pass' }).reasons.join('\n')).toContain(
			'rejected: quality signals are missing or inconsistent',
		);
	});

	it('fails closed for missing outcomes, unknown quality, and invalid windows', () => {
		const records = representativeRecords();
		const withoutOutcomes = records.filter((record) => record.event !== 's4_outcome');
		expect(analyzeS4(withoutOutcomes, { independentReview: 'pass' }).decision).toBe('incomplete');
		const unknown = representativeRecords();
		const unknownOutcome = unknown.find((record) => record.event === 's4_outcome')!;
		unknownOutcome.s4Outcome!.quality = 'unknown';
		expect(analyzeS4(unknown, { independentReview: 'pass' }).decision).toBe('incomplete');
		const malformed = representativeRecords();
		const malformedOutcome = malformed.find((record) => record.event === 's4_outcome')!;
		malformedOutcome.s4Outcome!.correlation.flowId = 'other-flow';
		expect(analyzeS4(malformed, { independentReview: 'pass' }).decision).toBe('incomplete');
		expect(analyzeS4(records, { from: 1, to: 2, independentReview: 'pass' }).decision).toBe(
			'incomplete',
		);
		expect(analyzeS4(records, { from: 2, to: 1, independentReview: 'pass' }).decision).toBe(
			'incomplete',
		);
	});

	it('writes consistent runtime artifacts and rejects missing option values', () => {
		const directory = mkdtempSync(join(tmpdir(), 'subagent-herdr-s4-'));
		try {
			writeFileSync(
				join(directory, 'subagent-herdr.telemetry.jsonl'),
				representativeRecords()
					.map((record) => JSON.stringify(record))
					.join('\n') + '\n',
			);
			const jsonPath = join(directory, 'decision.json');
			const markdownPath = join(directory, 'decision.md');
			const cliPath = fileURLToPath(new URL('../analysis/cli.ts', import.meta.url));
			const result = spawnSync(
				'npm',
				[
					'run',
					's4:gate',
					'--',
					directory,
					'--independent-review',
					'pass',
					'--json',
					jsonPath,
					'--markdown',
					markdownPath,
				],
				{ encoding: 'utf8', cwd: process.cwd() },
			);
			expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
			const artifact = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
				status: string;
				decision: string;
			};
			expect(artifact).toMatchObject({ status: 'ENFORCE_CANDIDATE', decision: 'pass' });
			expect(readFileSync(markdownPath, 'utf8')).toContain('ENFORCE_CANDIDATE');

			const invalid = spawnSync(process.execPath, [cliPath, '--s4', '--from', '--to', '0'], {
				encoding: 'utf8',
			});
			expect(invalid.status).toBe(2);
			expect(invalid.stderr).toContain('missing value for --from');
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
