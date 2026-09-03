import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/herdr.ts', async (importOriginal) => {
	const mod = await importOriginal<typeof import('../src/herdr.ts')>();
	return {
		...mod,
		closeTab: vi.fn(),
		getAgentStatus: vi.fn(),
		herdrCli: vi.fn(),
		sleep: vi.fn(),
	};
});

import {
	allocateLabel,
	closeSubagentFlow,
	listSubagents,
	reconcileRegistry,
	registerEntry,
	removeRegistryEntry,
	sessionLinkedEntries,
	updateRegistryEntry,
} from '../src/registry.ts';
import { readRegistry, sanitizeSegment } from '../src/registry-store.ts';
import { closeTab, getAgentStatus, herdrCli } from '../src/herdr.ts';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { makeRegistryEntry } from './helpers.ts';

let dir: string;

beforeEach(() => {
	dir = getAgentDir();
	vi.clearAllMocks();
	for (const f of ['subagent-herdr.json', 'subagent-herdr.json.lock', 'subagent-herdr.json.tmp']) {
		try {
			fs.unlinkSync(path.join(dir, f));
		} catch {}
	}
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('sanitizeSegment', () => {
	it('strips directory components and leading dots', () => {
		expect(sanitizeSegment('../../evil')).toBe('evil');
		expect(sanitizeSegment('/a/b')).toBe('b');
		expect(sanitizeSegment('.hidden')).toBe('hidden');
		expect(sanitizeSegment('..')).toBe('');
	});
	it('replaces unsafe characters', () => {
		expect(sanitizeSegment('my agent')).toBe('my_agent');
		expect(sanitizeSegment('a/b:c')).toBe('b_c');
	});
});

describe('readRegistry', () => {
	it('returns empty registry when file is missing', () => {
		expect(readRegistry()).toEqual({ counters: {}, tabs: {} });
	});
	it('returns empty registry for corrupt json', () => {
		fs.writeFileSync(path.join(dir, 'subagent-herdr.json'), 'not json{{');
		expect(readRegistry()).toEqual({ counters: {}, tabs: {} });
	});
	it('parses a valid registry', () => {
		const reg = { counters: { ws1: { worker: 2 } }, tabs: { 'ws1:worker-1': makeRegistryEntry() } };
		fs.writeFileSync(path.join(dir, 'subagent-herdr.json'), JSON.stringify(reg));
		expect(readRegistry()).toEqual(reg);
	});
});

describe('allocateLabel', () => {
	it('allocates sequential labels per agent and workspace', () => {
		expect(allocateLabel('worker').label).toBe('worker-1');
		expect(allocateLabel('worker').label).toBe('worker-2');
		expect(allocateLabel('reviewer').label).toBe('reviewer-1');
	});
	it('sanitizes agent names in labels', () => {
		expect(allocateLabel('my agent').label).toBe('my_agent-1');
	});
	it('skips labels whose session file already exists', () => {
		const sessionsDir = path.join(getAgentDir(), 'sessions');
		fs.mkdirSync(sessionsDir, { recursive: true });
		fs.writeFileSync(path.join(sessionsDir, 'subagent-ws1-worker-1.jsonl'), '');
		expect(allocateLabel('worker').label).toBe('worker-2');
	});
});

describe('registerEntry / updateRegistryEntry / removeRegistryEntry', () => {
	it('registers, patches, and removes entries', () => {
		registerEntry(makeRegistryEntry());
		let reg = readRegistry();
		expect(reg.tabs['ws1:worker-1']).toMatchObject({ status: 'done' });

		updateRegistryEntry('worker-1', { status: 'running', contextTokens: 100 });
		reg = readRegistry();
		expect(reg.tabs['ws1:worker-1']).toMatchObject({ status: 'running', contextTokens: 100 });
		expect(reg.counters).toEqual({});

		removeRegistryEntry('worker-1');
		expect(readRegistry().tabs).toEqual({});
	});
	it('updateRegistryEntry is a no-op for unknown labels', () => {
		expect(() => updateRegistryEntry('ghost-1', { status: 'done' })).not.toThrow();
	});
	it('writes registry atomically with a lock file', () => {
		registerEntry(makeRegistryEntry());
		expect(fs.existsSync(path.join(dir, 'subagent-herdr.json.lock'))).toBe(false);
		expect(fs.existsSync(path.join(dir, 'subagent-herdr.json'))).toBe(true);
	});
});

describe('sessionLinkedEntries', () => {
	it('returns entries matching the parent session', () => {
		registerEntry(makeRegistryEntry({ label: 'worker-1', parentSession: '/sess/a.jsonl' }));
		registerEntry(makeRegistryEntry({ label: 'worker-2', parentSession: '/sess/b.jsonl' }));
		const linked = sessionLinkedEntries('/sess/a.jsonl');
		expect(linked.map((e) => e.label)).toEqual(['worker-1']);
	});
	it('returns empty for undefined session file', () => {
		expect(sessionLinkedEntries(undefined)).toEqual([]);
	});
});

describe('listSubagents', () => {
	it('reports empty registry', () => {
		expect(listSubagents({})).toBe('No subagent sessions yet.');
		expect(listSubagents({ label: 'x' })).toContain('no matches');
	});
	it('lists entries with status, pane, and session file', () => {
		registerEntry(
			makeRegistryEntry({
				status: 'running',
				contextTokens: 1500,
				blockedSince: Date.now(),
				blockReason: 'approval',
				blockedPreview: 'run?',
			}),
		);
		registerEntry(makeRegistryEntry({ label: 'reviewer-1', agent: 'reviewer' }));
		const out = listSubagents({});
		expect(out).toContain('ws1:worker-1');
		expect(out).toContain('ws1:reviewer-1');
		expect(out).toContain('reuseLabel: worker-1');
		expect(out).toContain('running');
		expect(out).toContain('ctx:1.5k');
		expect(out).not.toContain('pane ws1:p10');
		expect(out).not.toContain('sessions/subagent-');
	});
	it('displays a workspace name while retaining the stable workspace id', () => {
		registerEntry(makeRegistryEntry({ workspaceName: 'Project Alpha' }));
		const out = listSubagents({});
		expect(out).toContain('Project Alpha (ws1):worker-1');
		expect(out).toContain('reuseLabel: worker-1');
	});
	it('falls back to the stable workspace id when no name is stored', () => {
		registerEntry(makeRegistryEntry());
		const out = listSubagents({});
		expect(out).toContain('ws1:worker-1');
	});
	it('includes the workspace name in the active-session header', () => {
		registerEntry(
			makeRegistryEntry({ workspaceName: 'Project Alpha', parentSession: '/sess/current.jsonl' }),
		);
		const out = listSubagents({ parentSession: '/sess/current.jsonl' });
		expect(out).toContain('active workspace: Project Alpha (ws1)');
	});
	it('preserves full-registry behavior for owner-less direct calls', () => {
		registerEntry(makeRegistryEntry({ label: 'worker-1' }));
		registerEntry(makeRegistryEntry({ label: 'worker-2', workspace: 'ws2', paneId: 'ws2:p20' }));

		const out = listSubagents({});
		expect(out).not.toContain('registry:');
		expect(out).toContain('ws1:worker-1');
		expect(out).toContain('reuseLabel: worker-1');
		expect(out).toContain('ws2:worker-2');
	});
	it('filters same-workspace entries by parent Pi session when requested', () => {
		registerEntry(makeRegistryEntry({ label: 'worker-1', parentSession: '/sess/current.jsonl' }));
		registerEntry(makeRegistryEntry({ label: 'worker-2', parentSession: '/sess/other.jsonl' }));

		const out = listSubagents({ parentSession: '/sess/current.jsonl' });
		expect(out).toContain('active workspace: ws1');
		expect(out).not.toContain('/sess/current.jsonl');
		expect(out).toContain('ws1:worker-1');
		expect(out).not.toContain('ws1:worker-2');
		expect(listSubagents({ parentSession: '/sess/other.jsonl' })).toContain('ws1:worker-2');
	});
	it('shows reuse count and task history metadata', () => {
		registerEntry(
			makeRegistryEntry({
				contextTokens: 42000,
				reuseCount: 3,
				tasks: ['review auth', 'review api', 'review db'],
			}),
		);
		registerEntry(makeRegistryEntry({ label: 'reviewer-1', agent: 'reviewer' }));
		const out = listSubagents({});
		const workerLine = out.split('\n').find((l) => l.includes('ws1:worker-1'))!;
		expect(workerLine).toContain('ctx:42k');
		expect(workerLine).toContain('reused:3');
		expect(workerLine).toContain('tasks:3');
		const reviewerLine = out.split('\n').find((l) => l.includes('ws1:reviewer-1'))!;
		expect(reviewerLine).not.toContain('reused:');
		expect(reviewerLine).not.toContain('tasks:');
	});
	it('filters by label (bare and qualified)', () => {
		registerEntry(makeRegistryEntry({ label: 'worker-1' }));
		registerEntry(makeRegistryEntry({ label: 'reviewer-1', agent: 'reviewer' }));
		expect(listSubagents({ label: 'reviewer-1' })).toContain('ws1:reviewer-1');
		expect(listSubagents({ label: 'ws1:reviewer-1' })).toContain('ws1:reviewer-1');
		expect(listSubagents({ label: 'worker-1' })).not.toContain('reviewer');
	});
	it('filters by status', () => {
		registerEntry(makeRegistryEntry({ label: 'worker-1', status: 'running' }));
		registerEntry(makeRegistryEntry({ label: 'reviewer-1', agent: 'reviewer', status: 'done' }));
		expect(listSubagents({ status: 'running' })).toContain('worker-1');
		expect(listSubagents({ status: 'running' })).not.toContain('reviewer-1');
	});
	it('keeps diagnostics out of the compact listing', () => {
		registerEntry(makeRegistryEntry({ lastError: 'child crashed mid-write' }));
		expect(listSubagents({})).not.toContain('error:');
		expect(listSubagents({})).not.toContain('pane ws1:p10');
		expect(listSubagents({ verbose: true })).toContain('error: child crashed mid-write');
		expect(listSubagents({ verbose: true })).toContain('pane ws1:p10');
		expect(listSubagents({ verbose: true })).toContain('sessions/subagent-');
	});

	it('points the verbose listing at the report file instead of repeating it', () => {
		registerEntry(
			makeRegistryEntry({
				lastRun: {
					at: 1,
					durationMs: 2000,
					toolCalls: 1,
					failedToolCalls: 0,
					repeatedReads: 0,
					turns: 1,
					cost: 0.01,
					contextTokens: 100,
					reportTokens: 4000,
					report: {
						tokens: 4000,
						digestTokens: 500,
						truncated: true,
						ledgerParsed: true,
						path: '/tmp/reports/worker-1-1.md',
					},
				},
			}),
		);
		expect(listSubagents({ verbose: true })).toContain('report: /tmp/reports/worker-1-1.md');
	});

	it('says when a session left no report on disk', () => {
		registerEntry(makeRegistryEntry({}));
		expect(listSubagents({ verbose: true })).toContain('report: none');
	});
});

describe('closeSubagentFlow', () => {
	it('reports when nothing is linked', async () => {
		const result = await closeSubagentFlow([], { hasUI: false, ui: {} as never });
		expect(result.content[0]).toEqual({
			type: 'text',
			text: 'No subagents are linked to this session.',
		});
		expect(closeTab).not.toHaveBeenCalled();
	});
	it('closes without UI confirmation', async () => {
		registerEntry(makeRegistryEntry());
		const result = await closeSubagentFlow([makeRegistryEntry()], {
			hasUI: false,
			ui: {} as never,
		});
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: 'Closed 1 subagent(s): ws1:worker-1',
		});
		expect(closeTab).toHaveBeenCalledWith('tab10');
		expect(readRegistry().tabs).toEqual({});
	});
	it('cancels when the user declines', async () => {
		registerEntry(makeRegistryEntry({ status: 'running' }));
		const confirm = vi.fn().mockResolvedValue(false);
		const result = await closeSubagentFlow([makeRegistryEntry({ status: 'running' })], {
			hasUI: true,
			ui: { confirm } as never,
		});
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: 'Canceled - no subagents were closed.',
		});
		expect(closeTab).not.toHaveBeenCalled();
		expect(readRegistry().tabs['ws1:worker-1']).toBeDefined();
	});
	it('closes after user confirmation and notes running entries', async () => {
		const confirm = vi.fn().mockResolvedValue(true);
		registerEntry(makeRegistryEntry({ status: 'running' }));
		const result = await closeSubagentFlow([makeRegistryEntry({ status: 'running' })], {
			hasUI: true,
			ui: { confirm } as never,
		});
		expect(confirm.mock.calls[0][0]).toBe('Close subagents?');
		expect(confirm.mock.calls[0][1]).toContain('1 still running');
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: 'Closed 1 subagent(s): ws1:worker-1',
		});
	});
});

describe('reconcileRegistry', () => {
	it('removes entries whose pane is gone', async () => {
		registerEntry(makeRegistryEntry());
		vi.mocked(herdrCli).mockResolvedValue({ error: { code: 'pane_not_found' } });
		await reconcileRegistry();
		expect(readRegistry().tabs).toEqual({});
	});
	it('marks idle running entries as done after two stable checks', async () => {
		registerEntry(makeRegistryEntry({ status: 'running' }));
		vi.mocked(herdrCli).mockResolvedValue({});
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'idle' });
		await reconcileRegistry();
		expect(readRegistry().tabs['ws1:worker-1']).toMatchObject({ status: 'done' });
	});
	it('keeps entries that are still working', async () => {
		registerEntry(makeRegistryEntry({ status: 'running' }));
		vi.mocked(herdrCli).mockResolvedValue({});
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'working' });
		await reconcileRegistry();
		expect(readRegistry().tabs['ws1:worker-1']).toMatchObject({ status: 'running' });
	});
	it('keeps non-running entries untouched', async () => {
		registerEntry(makeRegistryEntry({ status: 'done' }));
		vi.mocked(herdrCli).mockResolvedValue({});
		await reconcileRegistry();
		expect(readRegistry().tabs['ws1:worker-1']).toBeDefined();
	});
});
