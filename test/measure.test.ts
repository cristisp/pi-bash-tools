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
			subagentResult('2026-09-01T10:00:10.000Z', 800),
			msg('assistant', '2026-09-01T10:00:20.000Z'),
			msg('assistant', '2026-09-01T10:00:30.000Z'),
			subagentResult('2026-09-03T10:00:40.000Z', 400, reportPath),
		].join('\n'),
	);
	writeFileSync(
		join(sessions, 'subagent-wQ-worker-1.jsonl'),
		[msg('assistant', '2026-09-01T10:00:05.000Z')].join('\n'),
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
		expect(scan.results.map((r) => r.tokens)).toEqual([200, 120]);
		expect(scan.receivedTokens).toBe(320);
		// 200 tokens stayed in context across two later assistant turns; the last result had none.
		expect(scan.carryTokens).toBe(400);
	});

	it('recovers the report path from the delivered text', () => {
		const dir = fixture();
		const scan = scanSession(join(dir, 'sessions', '--cwd--', 'root.jsonl'), false);
		expect(scan.results[1].reportPath).toBe(join(dir, 'flows', 'f1', 'reports', 'worker-1-1.md'));
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

	it('renders the tables a human reads', () => {
		const m = measure(fixture());
		const md = renderMarkdown(m);
		expect(md).toContain('## Delivered `subagent` result size');
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
