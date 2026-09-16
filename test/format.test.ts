import { describe, expect, it } from 'vitest';
import {
	applyOutputByteCap,
	blockedSummaryLine,
	buildRunSummary,
	completionPatch,
	formatExecutionMetrics,
	formatBlockedPreview,
	formatTokens,
	formatToolCall,
	formatUsageStats,
	findPendingToolCall,
	getDisplayItems,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	registryBlockedInfo,
	statusTag,
} from '../src/format.ts';
import { assistantMsg, makeMetrics, makeSingleResult, toolResultMsg, userMsg } from './helpers.ts';

const fg = (_c: string, t: string) => `{${t}}`;

describe('formatTokens', () => {
	it('formats small counts as plain numbers', () => {
		expect(formatTokens(0)).toBe('0');
		expect(formatTokens(999)).toBe('999');
	});
	it('formats thousands with one decimal', () => {
		expect(formatTokens(1000)).toBe('1.0k');
		expect(formatTokens(1500)).toBe('1.5k');
		expect(formatTokens(9999)).toBe('10.0k');
	});
	it('formats tens of thousands rounded', () => {
		expect(formatTokens(10000)).toBe('10k');
		expect(formatTokens(15000)).toBe('15k');
		expect(formatTokens(999999)).toBe('1000k');
	});
	it('formats millions with one decimal', () => {
		expect(formatTokens(1500000)).toBe('1.5M');
	});
});

describe('formatExecutionMetrics', () => {
	it('renders compact execution metrics', () => {
		expect(
			formatExecutionMetrics({
				durationMs: 1500,
				toolCalls: 3,
				failedToolCalls: 1,
				repeatedReads: 2,
				messageCount: 7,
				taskChars: 100,
				outputChars: 2500,
				maxContextTokens: 12000,
				turns: 2,
				blockEvents: 0,
				approvalMs: 0,
				steerMs: 0,
			}),
		).toBe('time:1.5s tools:3 msgs:7 io:100/2500 tool-errors:1 rereads:2 max-ctx:12k');
	});

	it('shows which validation refs were minted and which were resolved', () => {
		expect(
			formatExecutionMetrics({
				durationMs: 900,
				toolCalls: 4,
				failedToolCalls: 0,
				repeatedReads: 0,
				messageCount: 5,
				taskChars: 10,
				outputChars: 20,
				maxContextTokens: 0,
				turns: 1,
				blockEvents: 0,
				approvalMs: 0,
				steerMs: 0,
				validationRefs: [
					{ ref: 'vr_aaa', verdict: 'passed', reused: false, lookup: false },
					{ ref: 'vr_aaa', verdict: 'passed', reused: true, lookup: true },
				],
			}),
		).toBe('time:900ms tools:4 msgs:5 io:10/20 verify:2 ran:1');
	});
});

describe('formatUsageStats', () => {
	it('returns empty string for zero usage', () => {
		expect(formatUsageStats({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })).toBe(
			'',
		);
	});
	it('renders all components in order', () => {
		const out = formatUsageStats(
			{
				input: 1000,
				output: 2000,
				cacheRead: 500,
				cacheWrite: 300,
				cost: 0.001234,
				contextTokens: 1500,
				turns: 2,
			},
			'model-x',
		);
		expect(out).toBe('2 turns ↑1.0k ↓2.0k R500 W300 $0.0012 ctx:1.5k model-x');
	});
	it('uses singular for one turn', () => {
		const out = formatUsageStats({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			turns: 1,
		});
		expect(out).toBe('1 turn');
	});
});

describe('formatToolCall', () => {
	it('renders bash commands with preview truncation', () => {
		const long = 'echo ' + 'x'.repeat(80);
		expect(formatToolCall('bash', { command: 'ls -la' }, fg)).toBe('{$ }{ls -la}');
		const out = formatToolCall('bash', { command: long }, fg);
		expect(out.includes('...')).toBe(true);
		expect(out.length).toBeLessThan(long.length);
	});
	it('renders read with offset and limit ranges', () => {
		expect(formatToolCall('read', { file_path: '/a/b.ts', offset: 10, limit: 5 }, fg)).toBe(
			'{read }{/a/b.ts}{:10-14}',
		);
		expect(formatToolCall('read', { path: '/a/b.ts', offset: 3 }, fg)).toBe('{read }{/a/b.ts}{:3}');
	});
	it('renders write with line count', () => {
		expect(formatToolCall('write', { file_path: '/a/b.ts', content: 'a\nb\nc' }, fg)).toBe(
			'{write }{/a/b.ts}{ (3 lines)}',
		);
		expect(formatToolCall('write', { path: '/a/b.ts', content: 'solo' }, fg)).toBe(
			'{write }{/a/b.ts}',
		);
	});
	it('renders edit, ls, find, grep', () => {
		expect(formatToolCall('edit', { file_path: '/a/b.ts' }, fg)).toBe('{edit }{/a/b.ts}');
		expect(formatToolCall('ls', { path: '/a' }, fg)).toBe('{ls }{/a}');
		expect(formatToolCall('find', { pattern: '*.ts', path: '/a' }, fg)).toBe(
			'{find }{*.ts}{ in /a}',
		);
		expect(formatToolCall('grep', { pattern: 'foo', path: '/a' }, fg)).toBe(
			'{grep }{/foo/}{ in /a}',
		);
	});
	it('renders unknown tools as json preview', () => {
		const out = formatToolCall('custom', { a: 1 }, fg);
		expect(out).toBe('{custom}{ {"a":1}}');
	});
	it('shortens home paths', () => {
		const home = process.env.HOME ?? '/none';
		expect(formatToolCall('read', { path: `${home}/x.ts` }, fg)).toBe(`{read }{~${'/x.ts'}}`);
	});
});

describe('formatBlockedPreview', () => {
	it('uses path when present', () => {
		expect(formatBlockedPreview('read', { path: '/a/b.ts' })).toBe('read /a/b.ts');
	});
	it('uses command for bash', () => {
		expect(formatBlockedPreview('bash', { command: '  rm  -rf  /tmp ' })).toBe('bash rm -rf /tmp');
	});
	it('falls back to tool name', () => {
		expect(formatBlockedPreview('custom', {})).toBe('custom');
	});
	it('truncates long previews', () => {
		const preview = formatBlockedPreview('bash', { command: 'x'.repeat(200) });
		expect(preview.length).toBeLessThanOrEqual(90);
		expect(preview.endsWith('...')).toBe(true);
	});
});

describe('getFinalOutput', () => {
	it('returns the last assistant text', () => {
		const messages = [userMsg('hi'), assistantMsg('first'), assistantMsg('second')];
		expect(getFinalOutput(messages)).toBe('second');
	});
	it('returns empty string without assistant text', () => {
		expect(getFinalOutput([userMsg('hi')])).toBe('');
		expect(getFinalOutput([])).toBe('');
	});
});

describe('isFailedResult', () => {
	it('flags non-zero exit codes', () => {
		expect(isFailedResult(makeSingleResult({ exitCode: 1 }))).toBe(true);
		expect(isFailedResult(makeSingleResult({ exitCode: -1 }))).toBe(true);
		expect(isFailedResult(makeSingleResult({ exitCode: 0 }))).toBe(false);
	});
	it('flags error and aborted stop reasons', () => {
		expect(isFailedResult(makeSingleResult({ stopReason: 'error' }))).toBe(true);
		expect(isFailedResult(makeSingleResult({ stopReason: 'aborted' }))).toBe(true);
		expect(isFailedResult(makeSingleResult({ stopReason: 'stop' }))).toBe(false);
	});
});

describe('buildRunSummary', () => {
	const usage = {
		input: 1,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0.5,
		contextTokens: 900,
		turns: 4,
	};

	it('keeps report counts and provenance without the digest text', () => {
		const report = {
			digest: 'digest body that must never reach the registry',
			tokens: 4000,
			digestTokens: 500,
			truncated: true,
			ledgerParsed: true,
			path: '/tmp/report.md',
		};
		const summary = buildRunSummary(
			makeMetrics({ toolCalls: 2, durationMs: 1000 }),
			usage,
			report,
			undefined,
			1234,
		);
		expect(summary).toEqual({
			at: 1234,
			durationMs: 1000,
			toolCalls: 2,
			failedToolCalls: 0,
			repeatedReads: 0,
			turns: 4,
			cost: 0.5,
			contextTokens: 900,
			reportTokens: 4000,
			report: {
				tokens: 4000,
				digestTokens: 500,
				truncated: true,
				ledgerParsed: true,
				path: '/tmp/report.md',
			},
		});
	});

	it('omits the report block when no report was built', () => {
		const summary = buildRunSummary(makeMetrics(), usage, undefined, undefined, 1234);
		expect(summary.report).toBeUndefined();
		expect(summary.reportTokens).toBeUndefined();
	});
});

describe('getResultOutput', () => {
	it('prefers errorMessage for failed results', () => {
		const r = makeSingleResult({ exitCode: 1, errorMessage: 'boom', stderr: 'stderr text' });
		expect(getResultOutput(r)).toBe('boom');
	});
	it('falls back to stderr', () => {
		const r = makeSingleResult({ exitCode: 1, stderr: 'stderr text' });
		expect(getResultOutput(r)).toBe('stderr text');
	});
	it('falls back to messages and defaults', () => {
		const r = makeSingleResult({ exitCode: 1, messages: [assistantMsg('out')] });
		expect(getResultOutput(r)).toBe('out');
		expect(getResultOutput(makeSingleResult({ exitCode: 1 }))).toBe('(no output)');
	});
	it('uses final output for successful results', () => {
		const r = makeSingleResult({ messages: [assistantMsg('done')] });
		expect(getResultOutput(r)).toBe('done');
	});
});

describe('findPendingToolCall', () => {
	it('returns the first pending call of the latest assistant message', () => {
		const msg = assistantMsg('', {
			toolCalls: [
				{ id: 't1', name: 'bash', args: { command: 'a' } },
				{ id: 't2', name: 'read', args: { path: '/x' } },
			],
		});
		const pending = new Map([
			['t1', { name: 'bash', args: { command: 'a' } }],
			['t2', { name: 'read', args: { path: '/x' } }],
		]);
		expect(findPendingToolCall([msg], pending)).toEqual({ name: 'bash', args: { command: 'a' } });
	});
	it('returns undefined when nothing is pending', () => {
		const msg = assistantMsg('', {
			toolCalls: [{ id: 't1', name: 'bash', args: { command: 'a' } }],
		});
		expect(findPendingToolCall([msg], new Map())).toBeUndefined();
	});
});

describe('blockedSummaryLine', () => {
	it('renders approval with preview, time, and tab', () => {
		const r = makeSingleResult({
			label: 'worker-1',
			paneId: 'ws1:p1',
			herdrStatus: 'blocked',
			blockReason: 'approval',
			blockedPreview: 'run this?',
			blockedSince: Date.UTC(2025, 0, 1, 10, 30),
		});
		const line = blockedSummaryLine(r);
		expect(line).toContain('blocked - awaiting approval: run this?');
		expect(line).toContain('approve/reject in tab ws1:worker-1');
	});
	it('renders steer without preview', () => {
		const r = makeSingleResult({ herdrStatus: 'blocked', blockReason: 'steer' });
		const line = blockedSummaryLine(r);
		expect(line).toContain('blocked - needs input');
		expect(line).toContain('(steer in its tab)');
	});
});

describe('statusTag', () => {
	it('maps blocked states', () => {
		expect(
			statusTag(
				makeSingleResult({ herdrStatus: 'blocked', blockReason: 'approval', blockedPreview: 'x' }),
			),
		).toBe('blocked - awaiting approval: x');
		expect(statusTag(makeSingleResult({ herdrStatus: 'blocked', blockReason: 'approval' }))).toBe(
			'blocked - awaiting approval',
		);
		expect(statusTag(makeSingleResult({ herdrStatus: 'blocked', blockReason: 'steer' }))).toBe(
			'blocked - needs input',
		);
	});
	it('maps working, idle/done, and unknown', () => {
		expect(statusTag(makeSingleResult({ herdrStatus: 'working' }))).toBe('working');
		expect(statusTag(makeSingleResult({ herdrStatus: 'idle' }))).toBe('settling');
		expect(statusTag(makeSingleResult({ herdrStatus: 'done' }))).toBe('settling');
		expect(statusTag(makeSingleResult())).toBe('starting');
	});

	it('reports the blocked tag for marker-driven blocks regardless of herdrStatus', () => {
		expect(
			statusTag(
				makeSingleResult({
					herdrStatus: 'working',
					blockReason: 'approval',
					blockedPreview: 'x',
					blockedSince: Date.UTC(2025, 0, 1),
				}),
			),
		).toBe('blocked - awaiting approval: x');
		expect(
			statusTag(
				makeSingleResult({
					herdrStatus: 'working',
					blockReason: 'steer',
					blockedSince: Date.UTC(2025, 0, 1),
				}),
			),
		).toBe('blocked - needs input');
	});
});

describe('registryBlockedInfo', () => {
	it('returns null when not running or not blocked', () => {
		expect(registryBlockedInfo({ ...makeSingleResult(), status: 'done' } as never)).toBeNull();
	});
	it('renders blocked info for running entries', () => {
		const info = registryBlockedInfo({
			status: 'running',
			blockedSince: Date.UTC(2025, 0, 1, 10, 30),
			blockReason: 'approval',
			blockedPreview: 'y',
		} as never);
		expect(info).toContain('blocked since');
		expect(info).toContain('awaiting approval: y');
	});
});

describe('completionPatch', () => {
	it('marks done and holds no prose for a settled turn', () => {
		const r = makeSingleResult({
			messages: [assistantMsg('final')],
			usage: { ...makeSingleResult().usage, contextTokens: 500 },
		});
		const patch = completionPatch(r);
		expect(patch.status).toBe('done');
		expect(patch.lastError).toBeUndefined();
		expect(patch.contextTokens).toBe(500);
		expect(patch.blockReason).toBeUndefined();
	});
	it('omits contextTokens when zero', () => {
		const patch = completionPatch(makeSingleResult());
		expect(patch.contextTokens).toBeUndefined();
	});

	it('stores the failure diagnosis for a child that never produced a report', () => {
		const patch = completionPatch(
			makeSingleResult({
				exitCode: 1,
				stderr: 'Unknown agent: "security-reviewer". Available agents: "reviewer".',
			}),
		);
		expect(patch.lastError).toBe(
			'Unknown agent: "security-reviewer". Available agents: "reviewer".',
		);
	});

	it('bounds the stored error', () => {
		const patch = completionPatch(
			makeSingleResult({ exitCode: 1, errorMessage: `boom ${'e'.repeat(2000)}` }),
		);
		const stored = patch.lastError ?? '';
		expect(stored.startsWith('boom eeee')).toBe(true);
		expect(stored.length).toBeLessThan(520);
		expect(stored.endsWith('...')).toBe(true);
		expect(stored).not.toContain('e'.repeat(1000));
	});

	it('normalizes whitespace in the stored error', () => {
		const patch = completionPatch(
			makeSingleResult({ exitCode: 1, stderr: 'child   crashed\n\nmid-write' }),
		);
		expect(patch.lastError).toBe('child crashed mid-write');
	});
});

describe('applyOutputByteCap', () => {
	it('passes through small output', () => {
		expect(applyOutputByteCap('short')).toBe('short');
	});
	it('truncates large output at the byte cap', () => {
		const big = 'x'.repeat(60 * 1024);
		const out = applyOutputByteCap(big);
		expect(out).toContain('Output truncated:');
		expect(out.startsWith('xxxxx')).toBe(true);
		expect(Buffer.byteLength(out)).toBeLessThan(52 * 1024);
	});
});

describe('getDisplayItems', () => {
	it('extracts text and tool calls in order', () => {
		const messages = [
			userMsg('ignore me'),
			assistantMsg('hello', { toolCalls: [{ id: 't1', name: 'bash', args: { command: 'ls' } }] }),
		];
		const items = getDisplayItems(messages);
		expect(items).toEqual([
			{ type: 'toolCall', name: 'bash', args: { command: 'ls' } },
			{ type: 'text', text: 'hello' },
		]);
	});
	it('ignores tool result messages', () => {
		expect(getDisplayItems([toolResultMsg('t1')])).toEqual([]);
	});
});
