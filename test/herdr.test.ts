import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
	execFile: execFileMock,
}));

import {
	closeTab,
	createTaskTab,
	getAgentStatus,
	herdrCli,
	herdrErrorCode,
	herdrErrorText,
	launchInPane,
	ownWorkspaceId,
	sleep,
} from '../src/herdr.ts';

function resolveWith(json: unknown): void {
	execFileMock.mockImplementationOnce(
		(
			_bin: string,
			_args: string[],
			_opts: unknown,
			cb: (err: Error | null, stdout: string, stderr: string) => void,
		) => {
			cb(null, JSON.stringify(json), '');
		},
	);
}

function resolveAlwaysWith(json: unknown): void {
	execFileMock.mockImplementation(
		(
			_bin: string,
			_args: string[],
			_opts: unknown,
			cb: (err: Error | null, stdout: string, stderr: string) => void,
		) => {
			cb(null, JSON.stringify(json), '');
		},
	);
}

function rejectWith(err: Error): void {
	execFileMock.mockImplementationOnce(
		(
			_bin: string,
			_args: string[],
			_opts: unknown,
			cb: (err: Error, stdout: string, stderr: string) => void,
		) => {
			cb(err, '', '');
		},
	);
}

beforeEach(() => {
	execFileMock.mockReset();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('herdrCli', () => {
	it('resolves parsed JSON from stdout', async () => {
		resolveWith({ result: { ok: true } });
		await expect(herdrCli(['pane', 'get', 'ws1:p1'])).resolves.toEqual({ result: { ok: true } });
		const args = execFileMock.mock.calls[0];
		expect(args[0]).toBe('herdr');
		expect(args[1]).toEqual(['pane', 'get', 'ws1:p1', '--session', 'ws1']);
	});

	it('falls back to stderr JSON', async () => {
		execFileMock.mockImplementationOnce((_bin, _args, _opts, cb) => {
			cb(null, 'not json', JSON.stringify({ error: { code: 'boom' } }));
		});
		await expect(herdrCli(['pane', 'get', 'p'])).resolves.toEqual({ error: { code: 'boom' } });
	});

	it('rejects when output is not JSON and exec fails', async () => {
		execFileMock.mockImplementationOnce((_bin, _args, _opts, cb) => {
			cb(new Error('nope'), 'plain text', '');
		});
		await expect(herdrCli(['pane', 'get', 'p'])).rejects.toThrow('herdr pane failed: nope');
	});

	it('resolves empty object for empty output', async () => {
		execFileMock.mockImplementationOnce((_bin, _args, _opts, cb) => cb(null, '', ''));
		await expect(herdrCli(['pane', 'get', 'p'])).resolves.toEqual({});
	});
});

describe('herdrErrorCode / herdrErrorText', () => {
	it('extracts error codes', () => {
		expect(herdrErrorCode({ error: { code: 'pane_not_found' } })).toBe('pane_not_found');
		expect(herdrErrorCode({})).toBeUndefined();
		expect(herdrErrorCode(undefined)).toBeUndefined();
	});
	it('renders error text from code and message', () => {
		expect(herdrErrorText({ error: { code: 'x', message: 'boom' } })).toBe('x: boom');
		expect(herdrErrorText({ error: { code: 'x', detail: 'detail' } })).toBe('x: detail');
		expect(herdrErrorText({ error: 'plain' })).toBe('plain');
		expect(herdrErrorText({})).toBe('');
	});
});

describe('ownWorkspaceId / resolveOwnWorkspace', () => {
	it('derives the workspace from the pane id at load time', () => {
		expect(ownWorkspaceId()).toBe('ws1');
	});

	it('resolves the workspace from herdr', async () => {
		vi.resetModules();
		resolveWith({ result: { pane: { workspace_id: 'wsX' } } });
		const { resolveOwnWorkspace } = await import('../src/herdr.ts');
		await expect(resolveOwnWorkspace()).resolves.toBe('wsX');
	});
	it('returns empty string when the pane is missing', async () => {
		vi.resetModules();
		vi.stubEnv('HERDR_PANE_ID', '');
		const { resolveOwnWorkspace } = await import('../src/herdr.ts');
		await expect(resolveOwnWorkspace()).resolves.toBe('');
	});
	it('returns empty string when herdr fails', async () => {
		vi.resetModules();
		rejectWith(new Error('boom'));
		const { resolveOwnWorkspace } = await import('../src/herdr.ts');
		await expect(resolveOwnWorkspace()).resolves.toBe('');
	});
});

describe('createTaskTab', () => {
	it('returns pane and tab ids', async () => {
		resolveWith({ result: { root_pane: { pane_id: 'ws1:p9' }, tab: { tab_id: 't9' } } });
		await expect(createTaskTab('ws1', '/tmp', 'worker-1')).resolves.toEqual({
			paneId: 'ws1:p9',
			tabId: 't9',
		});
	});
	it('throws on herdr errors', async () => {
		resolveWith({ error: { code: 'denied' } });
		await expect(createTaskTab('ws1', '/tmp', 'worker-1')).rejects.toThrow(
			'herdr tab create failed: denied',
		);
	});
	it('throws when ids are missing', async () => {
		resolveWith({ result: {} });
		await expect(createTaskTab('ws1', '/tmp', 'worker-1')).rejects.toThrow(
			'returned no pane/tab id',
		);
	});
});

describe('getAgentStatus', () => {
	it('maps agent statuses', async () => {
		resolveWith({ result: { agent: { agent_status: 'working' } } });
		await expect(getAgentStatus('ws1:p1')).resolves.toEqual({ status: 'working' });
	});
	it('maps agent_not_found to no-agent', async () => {
		resolveWith({ error: { code: 'agent_not_found' } });
		await expect(getAgentStatus('ws1:p1')).resolves.toEqual({ status: 'no-agent' });
	});
	it('maps pane_not_found to gone', async () => {
		resolveWith({ error: { code: 'pane_not_found' } });
		await expect(getAgentStatus('ws1:p1')).resolves.toEqual({ status: 'gone' });
	});
	it('falls back to unknown', async () => {
		resolveWith({ result: { agent: { agent_status: 'weird' } } });
		await expect(getAgentStatus('ws1:p1')).resolves.toEqual({ status: 'unknown' });
		rejectWith(new Error('boom'));
		await expect(getAgentStatus('ws1:p1')).resolves.toEqual({ status: 'unknown' });
	});
});

describe('closeTab', () => {
	it('closes the tab and swallows errors', async () => {
		resolveWith({ result: {} });
		await closeTab('t1');
		expect(execFileMock).toHaveBeenCalledWith(
			'herdr',
			['tab', 'close', 't1', '--session', 'ws1'],
			expect.anything(),
			expect.anything(),
		);
		rejectWith(new Error('boom'));
		await expect(closeTab('t1')).resolves.toBeUndefined();
	});
});

describe('launchInPane', () => {
	it('sends text then enter and returns null on success', async () => {
		vi.useFakeTimers();
		resolveWith({ result: {} });
		resolveWith({ result: {} });
		const p = launchInPane('ws1:p1', 'pi --task x');
		await vi.advanceTimersByTimeAsync(600);
		await expect(p).resolves.toBeNull();
		const calls = execFileMock.mock.calls.map((c) => c[1][1]);
		expect(calls[0]).toBe('send-text');
		expect(calls[1]).toBe('send-keys');
		expect(execFileMock.mock.calls[0][1]).toContain('pi --task x');
		vi.useRealTimers();
	});
	it('returns the error when sending text fails', async () => {
		vi.useFakeTimers();
		resolveAlwaysWith({ error: { code: 'denied', message: 'nope' } });
		const p = launchInPane('ws1:p1', 'pi');
		await vi.advanceTimersByTimeAsync(2600);
		await expect(p).resolves.toContain('denied');
		vi.useRealTimers();
	});
	it('returns submit failure when enter fails', async () => {
		vi.useFakeTimers();
		execFileMock.mockImplementationOnce((_bin, _args, _opts, cb) => {
			cb(null, JSON.stringify({ result: {} }), '');
		});
		resolveAlwaysWith({ error: { code: 'bad_keys' } });
		const p = launchInPane('ws1:p1', 'pi');
		await vi.advanceTimersByTimeAsync(2600);
		await expect(p).resolves.toContain('submit failed');
		vi.useRealTimers();
	});
	it('returns the thrown error as launch error', async () => {
		vi.useFakeTimers();
		execFileMock.mockImplementation(() => {
			throw new Error('exec exploded');
		});
		const p = launchInPane('ws1:p1', 'pi');
		await vi.advanceTimersByTimeAsync(2600);
		await expect(p).resolves.toContain('exec exploded');
		vi.useRealTimers();
	});
});

describe('sleep', () => {
	it('resolves after the given delay', async () => {
		vi.useFakeTimers();
		let resolved = false;
		const p = sleep(100);
		void p.then(() => {
			resolved = true;
			return undefined;
		});
		await vi.advanceTimersByTimeAsync(99);
		expect(resolved).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await p;
		expect(resolved).toBe(true);
		vi.useRealTimers();
	});
});
