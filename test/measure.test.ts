import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	defaultCutoff,
	estimateTokens,
	measure,
	quantiles,
	readTelemetry,
	renderMarkdown,
	scanSession,
	sessionFiles,
} from '../analysis/measure.ts';

function msg(role: string, at: string, text = 'hi'): string {
	return JSON.stringify({
		type: 'message',
		timestamp: at,
		message: { role, content: [{ type: 'text', text }] },
	});
}

function subagentResult(at: string, chars: number, reportPath?: string): string {
	const text = `${'x'.repeat(chars)}${reportPath ? `\n[full report: ${reportPath}]` : ''}`;
	return JSON.stringify({
		type: 'message',
		timestamp: at,
		message: {
			role: 'toolResult',
			toolCallId: 'call_1',
			toolName: 'subagent',
			content: [{ type: 'text', text }],
		},
	});
}

function readCall(at: string, path: string): string {
	return JSON.stringify({
		type: 'message',
		timestamp: at,
		message: {
			role: 'assistant',
			content: [
				{
					type: 'toolCall',
					name: 'read',
					arguments: { path, offset: 1, limit: 100 },
				},
			],
		},
	});
}

function telemetryRecord(overrides: Record<string, unknown>): string {
	return JSON.stringify({
		v: 1,
		at: 1000,
		delegationId: 'd1',
		workspace: 'wQ',
		label: 'worker-1',
		agent: 'worker',
		role: 'worker',
		evidenceScope: 'flow',
		reused: false,
		reuseCount: 0,
		outcome: 'settled',
		exitCode: 0,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.01,
			contextTokens: 1,
			turns: 1,
		},
		metrics: { durationMs: 1, toolCalls: 1 },
		...overrides,
	});
}

function fixture(): string {
	const dir = mkdtempSync(join(tmpdir(), 'orchestration-measure-'));
	const sessions = join(dir, 'sessions');
	mkdirSync(join(sessions, '--cwd--'), { recursive: true });
	const reportPath = join(dir, 'flows', 'f1', 'reports', 'worker-1-1.md');
	writeFileSync(
		join(sessions, '--cwd--', 'root.jsonl'),
		[
			JSON.stringify({ type: 'session', version: 3 }),
			msg('assistant', '2026-09-01T10:00:00.000Z'),
			readCall('2026-09-01T10:00:05.000Z', reportPath),
			readCall('2026-09-01T10:00:06.000Z', reportPath),
			readCall('2026-09-01T10:00:07.000Z', join(dir, 'PLAN.md')),
			subagentResult('2026-09-01T10:00:10.000Z', 800),
			msg('assistant', '2026-09-01T10:00:20.000Z'),
			msg('assistant', '2026-09-01T10:00:30.000Z'),
			subagentResult('2026-09-03T10:00:40.000Z', 400, reportPath),
		].join('\n'),
	);
	writeFileSync(
		join(sessions, 'subagent-wQ-worker-1.jsonl'),
		[
			msg('assistant', '2026-09-01T10:00:05.000Z'),
			readCall('2026-09-01T10:00:06.000Z', reportPath),
		].join('\n'),
	);
	writeFileSync(
		join(dir, 'subagent-herdr.telemetry.jsonl'),
		[
			telemetryRecord({ at: 1788000000000 }),
			telemetryRecord({
				at: 1788400000000,
				label: 'worker-2',
				role: 'reviewer',
				sessionFile: join(sessions, '--cwd--', 'missing.jsonl'),
				report: {
					tokens: 3000,
					digestTokens: 600,
					truncated: true,
					ledgerParsed: false,
					path: reportPath,
				},
			}),
			'{ torn line',
		].join('\n'),
	);
	return dir;
}

function guideFixture(renderedGuide?: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'orchestration-measure-guide-'));
	const sessions = join(dir, 'sessions');
	mkdirSync(join(sessions, '--cwd--'), { recursive: true });
	const guidePath = join(dir, 'agents', 'subagent_orchestration.md');
	writeFileSync(
		join(sessions, '--cwd--', 'root.jsonl'),
		[
			JSON.stringify({ type: 'session', version: 3 }),
			subagentResult('2026-09-01T10:00:00.000Z', 400),
			readCall('2026-09-01T10:00:05.000Z', guidePath),
			readCall('2026-09-01T10:00:06.000Z', join(dir, 'SUBAGENTS_GUIDE.md')),
			readCall('2026-09-01T10:00:07.000Z', join(dir, 'src', 'orchestration-guide.md')),
			subagentResult('2026-09-03T10:00:40.000Z', 400),
		].join('\n'),
	);
	writeFileSync(
		join(sessions, 'subagent-wQ-worker-1.jsonl'),
		[
			msg('assistant', '2026-09-01T10:00:05.000Z'),
			readCall('2026-09-01T10:00:06.000Z', guidePath),
		].join('\n'),
	);
	if (renderedGuide !== undefined) {
		mkdirSync(join(dir, 'agents'), { recursive: true });
		writeFileSync(guidePath, renderedGuide);
	}
	return dir;
}

/** One `validationRefs` entry, defaulted to a mint whose run executed the gate. */
function validationRef(overrides: Record<string, unknown>): Record<string, unknown> {
	return { ref: 'vr_seed', reused: false, lookup: false, ...overrides };
}

/** Telemetry `metrics` carrying refs, defaulting to one executed full validation pass. */
function refMetrics(refs: Record<string, unknown>[], passes = 1): Record<string, unknown> {
	return { durationMs: 1, toolCalls: 1, fullValidationPasses: passes, validationRefs: refs };
}

/**
 * Six delegations over two flows: two worker mints of one state digest in a single flow (the
 * duplicate execution W7 exists to remove), a mint of a second digest in that flow, a lookup of a
 * digest, a delegation with no ref at all, and a reused mint carrying the second digest again in a
 * different flow, which must not dedup against the first flow.
 */
function validationFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), 'orchestration-measure-refs-'));
	const digestA = 'aaaa11112222';
	const digestB = 'bbbb11112222';
	writeFileSync(
		join(dir, 'subagent-herdr.telemetry.jsonl'),
		[
			telemetryRecord({
				label: 'worker-1',
				role: 'worker',
				flowId: 'f1',
				metrics: refMetrics([validationRef({ ref: 'vr_a', stateDigest: digestA })]),
			}),
			telemetryRecord({
				label: 'worker-2',
				role: 'worker',
				flowId: 'f1',
				metrics: refMetrics([validationRef({ ref: 'vr_b', stateDigest: digestA })]),
			}),
			telemetryRecord({
				label: 'reviewer-1',
				role: 'reviewer',
				flowId: 'f1',
				metrics: refMetrics([validationRef({ ref: 'vr_c', stateDigest: digestB })]),
			}),
			telemetryRecord({
				label: 'reviewer-2',
				role: 'reviewer',
				flowId: 'f1',
				metrics: refMetrics(
					[validationRef({ ref: 'vr_c', lookup: true, stateDigest: digestB })],
					0,
				),
			}),
			telemetryRecord({
				label: 'validator-1',
				role: 'validator',
				flowId: 'f1',
				metrics: { durationMs: 1, toolCalls: 1 },
			}),
			telemetryRecord({
				label: 'validator-2',
				role: 'validator',
				flowId: 'f2',
				metrics: refMetrics(
					[validationRef({ ref: 'vr_c', reused: true, stateDigest: digestB })],
					0,
				),
			}),
		].join('\n'),
	);
	return dir;
}

describe('estimateTokens and quantiles', () => {
	it('uses the chars / 4 estimator', () => {
		expect(estimateTokens(800)).toBe(200);
	});
	it('returns zeroes for an empty sample', () => {
		expect(quantiles([])).toEqual({ count: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 });
	});
	it('computes the distribution the report prints', () => {
		const q = quantiles([1, 2, 3, 4]);
		expect(q).toMatchObject({ count: 4, avg: 3, p50: 3, p95: 4, max: 4 });
	});
});

describe('session scanning', () => {
	it('separates root and child session files', () => {
		const dir = fixture();
		const files = sessionFiles(dir);
		expect(files.filter((f) => f.child).map((f) => f.path)).toEqual([
			join(dir, 'sessions', 'subagent-wQ-worker-1.jsonl'),
		]);
		expect(files.filter((f) => !f.child)).toHaveLength(1);
	});

	it('sizes delivered results and counts re-reads from later turns', () => {
		const dir = fixture();
		const root = join(dir, 'sessions', '--cwd--', 'root.jsonl');
		const scan = scanSession(root, false);
		// The second result carries the report pointer line, so its size depends on the fixture path
		// length. Deriving it keeps the assertion stable across tmp roots (TMPDIR length varies by OS,
		// and test/setup.ts isolates it per file); the chars / 4 estimator itself is covered above.
		const reportPointer = `\n[full report: ${join(dir, 'flows', 'f1', 'reports', 'worker-1-1.md')}]`;
		const reportTokens = Math.ceil((400 + reportPointer.length) / 4);
		expect(scan.results.map((r) => r.tokens)).toEqual([200, reportTokens]);
		expect(scan.receivedTokens).toBe(200 + reportTokens);
		// 200 tokens stayed in context across two later assistant turns; the last result had none.
		expect(scan.carryTokens).toBe(400);
	});

	it('recovers the report path from the delivered text', () => {
		const dir = fixture();
		const scan = scanSession(join(dir, 'sessions', '--cwd--', 'root.jsonl'), false);
		expect(scan.results[1].reportPath).toBe(join(dir, 'flows', 'f1', 'reports', 'worker-1-1.md'));
	});

	it('counts flow report reads only from root sessions', () => {
		const dir = fixture();
		const root = scanSession(join(dir, 'sessions', '--cwd--', 'root.jsonl'), false);
		const child = scanSession(join(dir, 'sessions', 'subagent-wQ-worker-1.jsonl'), true);
		expect(root.reportReads).toBe(2);
		expect(root.reportReadTimestamps).toHaveLength(2);
		expect(root.reportReadTimestamps.every((at) => at > 0)).toBe(true);
		expect(child.reportReads).toBe(0);
	});

	it('ignores a torn final telemetry line', () => {
		expect(readTelemetry(fixture())).toHaveLength(2);
	});
});

describe('measure', () => {
	it('cuts the sample at the first turn that produced a report', () => {
		const dir = fixture();
		const records = readTelemetry(dir);
		expect(defaultCutoff(records)).toBe(1788400000000);
		const m = measure(dir);
		expect(m.delivered.before.count).toBe(1);
		expect(m.delivered.after.count).toBe(1);
		expect(m.delivered.all.count).toBe(2);
	});

	it('joins delivered results to telemetry by report path', () => {
		const m = measure(fixture());
		expect(m.joined).toBe(1);
		expect(m.reportTurns).toBe(1);
	});

	it('reports root flow-report reads around the cutoff', () => {
		const cutoff = Date.parse('2026-09-01T10:00:05.500Z');
		const m = measure(fixture(), cutoff);
		expect(m.rootReportReads).toBe(2);
		expect(m.rootReportReadsBefore).toBe(1);
		expect(m.rootReportReadsAfter).toBe(1);
	});

	it('reports per-role report sizes and ledger compliance', () => {
		const m = measure(fixture());
		expect(m.byRole).toEqual([
			{
				role: 'reviewer',
				turns: 1,
				medianFull: 3000,
				medianDigest: 600,
				ledgerParsed: 0,
				cost: 0.01,
			},
		]);
	});

	it('counts child sessions that telemetry cannot attribute', () => {
		const m = measure(fixture());
		expect(m.childSessions).toBe(1);
		expect(m.unattributedChildren).toBe(1);
	});

	it('charges refs, passes and per-flow digests to each role', () => {
		const m = measure(validationFixture());
		expect(m.validation.overall).toMatchObject({
			scope: 'overall',
			delegations: 6,
			delegationsWithRefs: 5,
			refsMinted: 4,
			refsExecuted: 3,
			refsReused: 1,
			refsResolvedByLookup: 1,
			fullValidationPasses: 3,
			// f1 carries aaaa and bbbb, f2 carries bbbb again: deduplication is scoped to one flow.
			distinctStateDigests: 3,
			executionsPerDigest: 1,
		});
	});

	it('dedupes two mints of one digest in one flow to two executions over one digest', () => {
		const worker = measure(validationFixture()).validation.byRole.find((r) => r.scope === 'worker');
		expect(worker).toMatchObject({
			delegations: 2,
			delegationsWithRefs: 2,
			refsMinted: 2,
			refsExecuted: 2,
			refsReused: 0,
			fullValidationPasses: 2,
			distinctStateDigests: 1,
			executionsPerDigest: 2,
		});
	});

	it('counts a ref resolved by lookup as a resolution, never as an execution', () => {
		const reviewer = measure(validationFixture()).validation.byRole.find(
			(r) => r.scope === 'reviewer',
		);
		expect(reviewer).toMatchObject({
			delegations: 2,
			refsMinted: 1,
			refsExecuted: 1,
			refsResolvedByLookup: 1,
			distinctStateDigests: 1,
			executionsPerDigest: 1,
		});
	});

	it('credits a reused mint with no execution against its digest', () => {
		const validator = measure(validationFixture()).validation.byRole.find(
			(r) => r.scope === 'validator',
		);
		expect(validator).toMatchObject({
			delegations: 2,
			delegationsWithRefs: 1,
			refsMinted: 1,
			refsExecuted: 0,
			refsReused: 1,
			fullValidationPasses: 0,
			distinctStateDigests: 1,
			executionsPerDigest: 0,
		});
	});

	it('reads carry no validation refs at all until child seats may mint them', () => {
		const m = measure(fixture());
		expect(m.validation.overall).toMatchObject({
			delegations: 2,
			delegationsWithRefs: 0,
			refsMinted: 0,
			refsResolvedByLookup: 0,
			fullValidationPasses: 0,
			distinctStateDigests: 0,
			executionsPerDigest: null,
		});
	});

	it('renders the tables a human reads', () => {
		const m = measure(fixture());
		const md = renderMarkdown(m);
		expect(md).toContain('## Delivered `subagent` result size');
		expect(md).toContain('## Root report reads (the W3 Slice D signal)');
		expect(md).toContain('| all | 2 |');
		expect(md).toContain('before cutoff');
		expect(md).toContain('baseline 2026-08-26..09-02');
		expect(md).toContain('| reviewer | 1 | 3000 | 600 | 20% | 0/1 | $0.0100 |');
		expect(md).toContain('have no telemetry record');
	});

	it('splits root carry at the cutoff so W3 can be judged against it', () => {
		const m = measure(fixture());
		expect(m.carry.rootCarryTokens).toBe(400);
		expect(m.carry.delegatingRoots).toBe(1);
		expect(m.carry.beforeCarryTokens).toBe(400);
		expect(m.carry.afterCarryTokens).toBe(0);
		expect(m.carry.meanCarryPerDelegatingRootBefore).toBe(400);
		expect(m.carry.meanCarryPerDelegatingRootAfter).toBe(0);
		expect(m.childrenInTelemetryWindow).toBe(1);
		expect(m.unattributedChildren).toBe(1);
	});
});

describe('guide reads (the W8 target)', () => {
	it('counts guide reads from root sessions only', () => {
		const dir = guideFixture();
		const root = scanSession(join(dir, 'sessions', '--cwd--', 'root.jsonl'), false);
		const child = scanSession(join(dir, 'sessions', 'subagent-wQ-worker-1.jsonl'), true);
		// The rendered guide plus the retired name count; the guide template in src does not.
		expect(root.guideReads).toBe(2);
		expect(root.guideReadTimestamps).toHaveLength(2);
		expect(child.guideReads).toBe(0);
	});

	it('splits guide reads at the cutoff and prices them per delegating root', () => {
		const cutoff = Date.parse('2026-09-01T10:00:05.500Z');
		const m = measure(guideFixture(), cutoff);
		expect(m.guide.reads).toBe(2);
		expect(m.guide.readsBefore).toBe(1);
		expect(m.guide.readsAfter).toBe(1);
		expect(m.guide.readsPerRoot).toBe(2);
		expect(m.guide.readsPerRootBefore).toBe(1);
		expect(m.guide.readsPerRootAfter).toBe(1);
	});

	it('sizes the rendered guide with the chars / 4 estimator', () => {
		const m = measure(guideFixture('x'.repeat(2000)));
		expect(m.guide.renderedChars).toBe(2000);
		expect(m.guide.renderedTokens).toBe(500);
		expect(renderMarkdown(m)).toContain('| rendered guide (est. tokens) | 500 | - |');
	});

	it('renders a dash, not a crash, when the rendered guide is absent', () => {
		const m = measure(guideFixture());
		expect(m.guide.renderedTokens).toBeNull();
		expect(m.guide.renderedChars).toBe(0);
		const md = renderMarkdown(m);
		expect(md).toContain('## Guide reads and rendered size (the W8 target)');
		expect(md).toContain('| rendered guide (est. tokens) | - | - |');
		expect(md).toContain('reads `-` when that file is absent');
	});

	it('states the mint-authorization caveat and the duplicate-call baseline in the W7 section', () => {
		const md = renderMarkdown(measure(validationFixture()));
		expect(md).toContain('## Validation evidence (the W7 target)');
		expect(md).toContain('| overall | 6 | 5 | 4 | 3 | 1 | 1 | 3 | 3 | 1.00 |');
		expect(md).toContain('| worker | 2 | 2 | 2 | 2 | 0 | 0 | 2 | 1 | 2.00 |');
		expect(md).toContain('1,075 duplicate project_command calls, 49.7%');
		expect(md).toContain('`F9` in `analysis/BASH_TOOLS_FOLLOWUPS.md`');
		expect(md).toContain('rather than that validation was deduplicated');
	});
});
