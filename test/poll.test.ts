import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/herdr.ts', async (importOriginal) => {
	const mod = await importOriginal<typeof import('../src/herdr.ts')>();
	return {
		...mod,
		getAgentStatus: vi.fn(),
	};
});

import { getAgentStatus } from '../src/herdr.ts';
import { BUDGET_STEER_MESSAGE, BUDGET_STEER_PREFIX } from '../src/budget.ts';
import { roleBudgetFor } from '../src/config.ts';
import { pollSubagent } from '../src/poll.ts';
import { registerEntry } from '../src/registry.ts';
import { readRegistry } from '../src/registry-store.ts';
import { UI_PROMPT_MARKER_ENTRY_TYPE } from '../src/ui-prompt-marker.ts';
import type {
	BlockEventInfo,
	OnUpdateCallback,
	SingleResult,
	SubagentDetails,
} from '../src/types.ts';
import {
	assistantMsg,
	makeRegistryEntry,
	makeSingleResult,
	makeTempDir,
	toolResultMsg,
	userMsg,
	writeSessionFile,
} from './helpers.ts';

function makeDetails(results: SingleResult[]): SubagentDetails {
	return { mode: 'single', agentScope: 'user', projectAgentsDir: null, results };
}

const INTERVAL_MS = 1500;

async function driveTimers(promise: Promise<unknown>, maxIterations: number): Promise<void> {
	for (let i = 0; i < maxIterations; i++) {
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		if ((await Promise.race([promise.then(() => 'done'), Promise.resolve('pending')])) === 'done') {
			return;
		}
	}
}

function registerBlockedEntry(sessionFile: string, dir: string): void {
	registerEntry({
		label: 'worker-1',
		agent: 'worker',
		workspace: 'ws1',
		paneId: 'ws1:p1',
		tabId: 'tab1',
		sessionFile,
		cwd: dir,
		status: 'running',
		createdAt: Date.now(),
		updatedAt: Date.now(),
	});
}

function blockedSessionFile(dir: string): string {
	return writeSessionFile(dir, 'session.jsonl', [
		assistantMsg('', {
			toolCalls: [{ id: 'tc1', name: 'bash', args: { command: 'rm -rf /' } }],
		}),
	]);
}

function uiPromptMarkerLine(event: 'start' | 'end', title?: string): string {
	const data: Record<string, unknown> = { formatVersion: 1, event, kind: 'select' };
	if (title !== undefined) data.title = title;
	return `${JSON.stringify({ type: 'custom', customType: UI_PROMPT_MARKER_ENTRY_TYPE, data })}\n`;
}

function startPoll(
	sessionFile: string,
	result: SingleResult,
	onUpdate?: OnUpdateCallback | undefined,
	onBlocked?: ((info: BlockEventInfo) => void) | undefined,
): Promise<'settled' | 'failed' | 'gone' | 'aborted'> {
	return pollSubagent(
		'ws1:p1',
		sessionFile,
		0,
		undefined,
		result,
		onUpdate,
		makeDetails,
		onBlocked,
	);
}

describe('pollSubagent - ui prompt markers', () => {
	it('blocks approval from a start marker while the daemon reports working', async () => {
		vi.useFakeTimers();
		const dir = makeTempDir();
		const sessionFile = blockedSessionFile(dir);
		fs.appendFileSync(sessionFile, uiPromptMarkerLine('start', 'Allow bash command?'));
		registerBlockedEntry(sessionFile, dir);
		vi.mocked(getAgentStatus)
			.mockResolvedValueOnce({ status: 'working' })
			.mockResolvedValue({ status: 'gone' });
		const result = makeSingleResult({ label: 'worker-1', paneId: 'ws1:p1' });
		const onBlocked = vi.fn();
		const promise = startPoll(sessionFile, result, undefined, onBlocked);
		await driveTimers(promise, 5);
		await expect(promise).resolves.toBe('gone');
		expect(result.blockReason).toBe('approval');
		expect(result.blockedPreview).toBe('bash rm -rf /');
		expect(result.blockedSince).toBeDefined();
		expect(onBlocked).toHaveBeenCalledTimes(1);
		expect(onBlocked).toHaveBeenCalledWith({
			label: 'worker-1',
			blockReason: 'approval',
			preview: 'bash rm -rf /',
		});
		const reg = readRegistry();
		expect(reg.tabs['ws1:worker-1']).toMatchObject({
			status: 'running',
			blockReason: 'approval',
			blockedPreview: 'bash rm -rf /',
		});
	});

	it('resolves a marker-driven block when the end marker arrives', async () => {
		vi.useFakeTimers();
		const dir = makeTempDir();
		const sessionFile = blockedSessionFile(dir);
		fs.appendFileSync(sessionFile, uiPromptMarkerLine('start'));
		registerBlockedEntry(sessionFile, dir);
		vi.mocked(getAgentStatus).mockImplementation(async () =>
			fs.readFileSync(sessionFile, 'utf8').includes('"event":"end"')
				? { status: 'gone' }
				: { status: 'working' },
		);
		const result = makeSingleResult({ label: 'worker-1', paneId: 'ws1:p1' });
		const onBlocked = vi.fn();
		const promise = startPoll(sessionFile, result, undefined, onBlocked);
		let appended = false;
		for (let i = 0; i < 6; i++) {
			await vi.advanceTimersByTimeAsync(INTERVAL_MS);
			if (!appended) {
				appended = true;
				fs.appendFileSync(sessionFile, uiPromptMarkerLine('end'));
			}
			if (
				(await Promise.race([promise.then(() => 'done'), Promise.resolve('pending')])) === 'done'
			) {
				break;
			}
		}
		await expect(promise).resolves.toBe('gone');
		expect(onBlocked).toHaveBeenCalledTimes(2);
		expect(onBlocked).toHaveBeenNthCalledWith(1, {
			label: 'worker-1',
			blockReason: 'approval',
			preview: 'bash rm -rf /',
		});
		expect(onBlocked).toHaveBeenNthCalledWith(2, {
			label: 'worker-1',
			blockReason: 'approval',
			resolved: true,
		});
		expect(result.blockReason).toBeUndefined();
		expect(result.blockedPreview).toBeUndefined();
		const reg = readRegistry();
		expect(reg.tabs['ws1:worker-1'].blockReason).toBeUndefined();
		expect(reg.tabs['ws1:worker-1'].blockedPreview).toBeUndefined();
	});

	it('reports a steer block with the prompt title when no tool call is pending', async () => {
		vi.useFakeTimers();
		const dir = makeTempDir();
		const sessionFile = writeSessionFile(dir, 'session.jsonl', [assistantMsg('thinking')]);
		fs.appendFileSync(sessionFile, uiPromptMarkerLine('start', 'Confirm cleanup'));
		registerBlockedEntry(sessionFile, dir);
		vi.mocked(getAgentStatus)
			.mockResolvedValueOnce({ status: 'working' })
			.mockResolvedValue({ status: 'gone' });
		const result = makeSingleResult({ label: 'worker-1', paneId: 'ws1:p1' });
		const onBlocked = vi.fn();
		const promise = startPoll(sessionFile, result, undefined, onBlocked);
		await driveTimers(promise, 5);
		await expect(promise).resolves.toBe('gone');
		expect(result.blockReason).toBe('steer');
		expect(result.blockedPreview).toBe('Confirm cleanup');
		expect(onBlocked).not.toHaveBeenCalled();
		const reg = readRegistry();
		expect(reg.tabs['ws1:worker-1']).toMatchObject({
			blockReason: 'steer',
			blockedPreview: 'Confirm cleanup',
		});
	});

	it('keeps daemon-only behavior when no markers exist', async () => {
		vi.useFakeTimers();
		const dir = makeTempDir();
		const sessionFile = writeSessionFile(dir, 'session.jsonl', [assistantMsg('in progress')]);
		vi.mocked(getAgentStatus)
			.mockResolvedValueOnce({ status: 'working' })
			.mockResolvedValue({ status: 'gone' });
		const result = makeSingleResult();
		const onBlocked = vi.fn();
		const promise = startPoll(sessionFile, result, undefined, onBlocked);
		await driveTimers(promise, 5);
		await expect(promise).resolves.toBe('gone');
		expect(result.blockReason).toBeUndefined();
		expect(result.blockedSince).toBeUndefined();
		expect(onBlocked).not.toHaveBeenCalled();
	});

	it('expires a lost end marker after the idle grace, settles, and stays silent', async () => {
		vi.useFakeTimers();
		const dir = makeTempDir();
		const sessionFile = writeSessionFile(dir, 'session.jsonl', [assistantMsg('final answer')]);
		fs.appendFileSync(sessionFile, uiPromptMarkerLine('start', 'Approve write?'));
		fs.writeFileSync(
			path.join(process.env.PI_CODING_AGENT_DIR!, 'subagent-herdr.config.json'),
			JSON.stringify({ uiPromptLostIdleMs: 5000 }),
		);
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'idle' });
		const result = makeSingleResult();
		const onBlocked = vi.fn();
		const promise = startPoll(sessionFile, result, undefined, onBlocked);
		await driveTimers(promise, 3);
		expect(await Promise.race([promise.then(() => 'settled'), Promise.resolve('pending')])).toBe(
			'pending',
		);
		expect(result.blockReason).toBe('steer');
		expect(result.blockedPreview).toBe('Approve write?');
		await driveTimers(promise, 10);
		await expect(promise).resolves.toBe('settled');
		expect(result.blockReason).toBeUndefined();
		expect(result.blockedPreview).toBeUndefined();
		expect(result.blockedSince).toBeUndefined();
		expect(onBlocked).not.toHaveBeenCalled();
	});

	it('keeps a lost end marker blocked while the daemon reports working past the grace', async () => {
		vi.useFakeTimers();
		const dir = makeTempDir();
		const sessionFile = blockedSessionFile(dir);
		fs.appendFileSync(sessionFile, uiPromptMarkerLine('start', 'Allow bash command?'));
		fs.writeFileSync(
			path.join(process.env.PI_CODING_AGENT_DIR!, 'subagent-herdr.config.json'),
			JSON.stringify({ uiPromptLostIdleMs: 1000 }),
		);
		registerBlockedEntry(sessionFile, dir);
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'working' });
		const result = makeSingleResult({ label: 'worker-1', paneId: 'ws1:p1' });
		const onBlocked = vi.fn();
		const promise = startPoll(sessionFile, result, undefined, onBlocked);
		await driveTimers(promise, 6);
		expect(await Promise.race([promise.then(() => 'settled'), Promise.resolve('pending')])).toBe(
			'pending',
		);
		expect(result.blockReason).toBe('approval');
		expect(result.blockedSince).toBeDefined();
		expect(onBlocked).toHaveBeenCalledTimes(1);
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'gone' });
		await driveTimers(promise, 3);
		await expect(promise).resolves.toBe('gone');
		expect(result.blockReason).toBe('approval');
	});

	it('suppresses settling while a ui prompt marker is open', async () => {
		vi.useFakeTimers();
		const dir = makeTempDir();
		const sessionFile = writeSessionFile(dir, 'session.jsonl', [assistantMsg('final answer')]);
		fs.appendFileSync(sessionFile, uiPromptMarkerLine('start', 'Approve write?'));
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'idle' });
		const result = makeSingleResult();
		const promise = startPoll(sessionFile, result);
		await driveTimers(promise, 10);
		expect(await Promise.race([promise.then(() => 'settled'), Promise.resolve('pending')])).toBe(
			'pending',
		);
		expect(result.blockReason).toBe('steer');
		expect(result.blockedPreview).toBe('Approve write?');
		fs.appendFileSync(sessionFile, uiPromptMarkerLine('end'));
		await driveTimers(promise, 5);
		await expect(promise).resolves.toBe('settled');
		expect(result.blockReason).toBeUndefined();
	});
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
	vi.clearAllMocks();
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	if (agentDir) {
		const cfgFile = path.join(agentDir, 'subagent-herdr.config.json');
		if (fs.existsSync(cfgFile)) fs.unlinkSync(cfgFile);
	}
});

describe('pollSubagent - startup', () => {
	it('uses poll interval and startup timeout from config', async () => {
		vi.useFakeTimers();
		const dir = makeTempDir();
		const sessionFile = path.join(dir, 'session.jsonl');
		fs.writeFileSync(sessionFile, '');
		fs.writeFileSync(
			path.join(process.env.PI_CODING_AGENT_DIR!, 'subagent-herdr.config.json'),
			JSON.stringify({ pollIntervalMs: 50, startupTimeoutMs: 100 }),
		);
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'idle' });
		const result = makeSingleResult();
		const promise = startPoll(sessionFile, result);
		await driveTimers(promise, 10);
		await expect(promise).resolves.toBe('failed');
		expect(result.stderr).toBe('subagent did not start');
	});

	it('fails with a startup timeout when nothing ever runs', async () => {
		vi.useFakeTimers();
		const dir = makeTempDir();
		const sessionFile = path.join(dir, 'session.jsonl');
		fs.writeFileSync(sessionFile, '');
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'idle' });
		const result = makeSingleResult();
		const promise = startPoll(sessionFile, result);
		await driveTimers(promise, 22);
		await expect(promise).resolves.toBe('failed');
		expect(result.stderr).toBe('subagent did not start');
	});
});

describe('pollSubagent - terminal states', () => {
	it('returns aborted immediately for an already-aborted signal', async () => {
		const dir = makeTempDir();
		const sessionFile = path.join(dir, 'session.jsonl');
		fs.writeFileSync(sessionFile, '');
		const result = makeSingleResult();
		await expect(
			pollSubagent('ws1:p1', sessionFile, 0, AbortSignal.abort(), result, undefined, makeDetails),
		).resolves.toBe('aborted');
		expect(getAgentStatus).not.toHaveBeenCalled();
	});

	it('returns gone when the pane is gone', async () => {
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'gone' });
		const dir = makeTempDir();
		const sessionFile = path.join(dir, 'session.jsonl');
		fs.writeFileSync(sessionFile, '');
		const result = makeSingleResult();
		await expect(startPoll(sessionFile, result)).resolves.toBe('gone');
	});

	it('fails when agent status is lost', async () => {
		vi.useFakeTimers();
		const dir = makeTempDir();
		const sessionFile = writeSessionFile(dir, 'session.jsonl', [
			assistantMsg('started but status unknown'),
		]);
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'unknown' });
		const result = makeSingleResult();
		const promise = startPoll(sessionFile, result);
		await driveTimers(promise, 44);
		await expect(promise).resolves.toBe('failed');
		expect(result.stderr).toBe('herdr agent status was lost');
	});
});

describe('pollSubagent - settling', () => {
	it('settles after stable idle with assistant output and tracks usage', async () => {
		vi.useFakeTimers();
		const dir = makeTempDir();
		const sessionFile = writeSessionFile(dir, 'session.jsonl', [
			assistantMsg('final answer', {
				stopReason: 'stop',
				usage: {
					input: 100,
					output: 50,
					cacheRead: 10,
					cacheWrite: 5,
					totalTokens: 150,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
				},
			}),
		]);
		vi.mocked(getAgentStatus)
			.mockResolvedValueOnce({ status: 'working' })
			.mockResolvedValue({ status: 'idle' });
		const result = makeSingleResult();
		const promise = startPoll(sessionFile, result);
		await driveTimers(promise, 10);
		await expect(promise).resolves.toBe('settled');
		expect(result.herdrStatus).toBe('idle');
		expect(result.usage.turns).toBe(1);
		expect(result.usage.input).toBe(100);
		expect(result.usage.output).toBe(50);
		expect(result.usage.cacheRead).toBe(10);
		expect(result.usage.cacheWrite).toBe(5);
		expect(result.usage.contextTokens).toBe(150);
		expect(result.usage.cost).toBeCloseTo(0.001);
		expect(result.model).toBe('test-model');
		expect(result.stopReason).toBe('stop');
	});

	it('counts a manual prefix message but excludes only the actual automatic steer', async () => {
		const dir = makeTempDir();
		const automaticSteerId = 'automatic-secret';
		registerEntry(
			makeRegistryEntry({
				label: 'worker-1',
				budget: {
					role: 'worker',
					limits: roleBudgetFor('worker'),
					usage: {
						toolCalls: 0,
						nestedToolCalls: 0,
						discoveryCalls: 0,
						fullValidationPasses: 0,
						failedToolCalls: 0,
						repeatedReads: 0,
						outputTokens: 0,
						wallTimeMs: 0,
					},
					outcome: 'steered',
					breaches: [],
					steerIssued: true,
					reportOnly: true,
					automaticSteerId,
				},
			}),
		);
		const sessionFile = writeSessionFile(dir, 'session.jsonl', [
			userMsg('original task'),
			assistantMsg('first answer'),
			userMsg(`${BUDGET_STEER_MESSAGE} [${automaticSteerId}]`),
			assistantMsg('budget response'),
			userMsg(`${BUDGET_STEER_PREFIX} manually authored message`),
			assistantMsg('second answer'),
		]);
		vi.mocked(getAgentStatus)
			.mockResolvedValueOnce({ status: 'working' })
			.mockResolvedValue({ status: 'gone' });
		const result = makeSingleResult({ label: 'worker-1' });
		await expect(startPoll(sessionFile, result)).resolves.toBe('gone');
		expect(result.steered).toBe(true);
	});
});

describe('pollSubagent - status updates', () => {
	it('emits status updates when the state changes', async () => {
		vi.useFakeTimers();
		const dir = makeTempDir();
		const sessionFile = writeSessionFile(dir, 'session.jsonl', [assistantMsg('in progress')]);
		vi.mocked(getAgentStatus)
			.mockResolvedValueOnce({ status: 'working' })
			.mockResolvedValue({ status: 'idle' });
		const result = makeSingleResult();
		const updates: string[] = [];
		const promise = startPoll(sessionFile, result, (partial) => {
			const text = partial.content[0];
			if (text?.type === 'text') updates.push(text.text);
		});
		await driveTimers(promise, 10);
		await expect(promise).resolves.toBe('settled');
		expect(updates.length).toBeGreaterThanOrEqual(1);
		expect(updates[updates.length - 1]).toContain('in progress');
	});
});

describe('pollSubagent - approval blocks', () => {
	it('detects approval blocks and notifies once', async () => {
		vi.useFakeTimers();
		const dir = makeTempDir();
		const sessionFile = blockedSessionFile(dir);
		registerBlockedEntry(sessionFile, dir);
		vi.mocked(getAgentStatus)
			.mockResolvedValueOnce({ status: 'blocked' })
			.mockResolvedValueOnce({ status: 'blocked' })
			.mockResolvedValue({ status: 'gone' });
		const result = makeSingleResult({ label: 'worker-1', paneId: 'ws1:p1' });
		const onBlocked = vi.fn();
		const promise = startPoll(sessionFile, result, undefined, onBlocked);
		await driveTimers(promise, 5);
		await expect(promise).resolves.toBe('gone');
		expect(result.blockReason).toBe('approval');
		expect(result.blockedPreview).toBe('bash rm -rf /');
		expect(result.blockedSince).toBeDefined();
		expect(onBlocked).toHaveBeenCalledTimes(1);
		expect(onBlocked).toHaveBeenCalledWith({
			label: 'worker-1',
			blockReason: 'approval',
			preview: 'bash rm -rf /',
		});
		const reg = readRegistry();
		expect(reg.tabs['ws1:worker-1']).toMatchObject({
			status: 'running',
			blockReason: 'approval',
			blockedPreview: 'bash rm -rf /',
		});
		expect(reg.tabs['ws1:worker-1'].blockedSince).toBeDefined();
	});

	it('notifies when an approval block is resolved', async () => {
		vi.useFakeTimers();
		const dir = makeTempDir();
		const sessionFile = blockedSessionFile(dir);
		registerBlockedEntry(sessionFile, dir);
		vi.mocked(getAgentStatus)
			.mockResolvedValueOnce({ status: 'blocked' })
			.mockResolvedValueOnce({ status: 'idle' })
			.mockResolvedValue({ status: 'gone' });
		const result = makeSingleResult({ label: 'worker-1', paneId: 'ws1:p1' });
		const onBlocked = vi.fn();
		const promise = startPoll(sessionFile, result, undefined, onBlocked);
		await driveTimers(promise, 5);
		await expect(promise).resolves.toBe('gone');
		expect(onBlocked).toHaveBeenCalledTimes(2);
		expect(onBlocked).toHaveBeenNthCalledWith(1, {
			label: 'worker-1',
			blockReason: 'approval',
			preview: 'bash rm -rf /',
		});
		expect(onBlocked).toHaveBeenNthCalledWith(2, {
			label: 'worker-1',
			blockReason: 'approval',
			resolved: true,
		});
		expect(result.blockReason).toBeUndefined();
	});
});

describe('pollSubagent - block transitions', () => {
	it('notifies when an approval block resolves into a steer block', async () => {
		vi.useFakeTimers();
		const dir = makeTempDir();
		const sessionFile = blockedSessionFile(dir);
		registerBlockedEntry(sessionFile, dir);
		vi.mocked(getAgentStatus).mockImplementation(async () => {
			const raw = fs.readFileSync(sessionFile, 'utf8');
			return raw.includes('instead do this') ? { status: 'gone' } : { status: 'blocked' };
		});
		const result = makeSingleResult({ label: 'worker-1', paneId: 'ws1:p1' });
		const onBlocked = vi.fn();
		const promise = startPoll(sessionFile, result, undefined, onBlocked);
		let appended = false;
		for (let i = 0; i < 6; i++) {
			await vi.advanceTimersByTimeAsync(INTERVAL_MS);
			if (!appended) {
				appended = true;
				fs.appendFileSync(
					sessionFile,
					`${JSON.stringify({ type: 'message', message: toolResultMsg('tc1') })}\n${JSON.stringify({ type: 'message', message: userMsg('instead do this') })}\n`,
				);
			}
			if (
				(await Promise.race([promise.then(() => 'done'), Promise.resolve('pending')])) === 'done'
			) {
				break;
			}
		}
		await expect(promise).resolves.toBe('gone');
		expect(onBlocked).toHaveBeenCalledTimes(2);
		expect(onBlocked).toHaveBeenNthCalledWith(1, {
			label: 'worker-1',
			blockReason: 'approval',
			preview: 'bash rm -rf /',
		});
		expect(onBlocked).toHaveBeenNthCalledWith(2, {
			label: 'worker-1',
			blockReason: 'steer',
			resolved: true,
		});
		expect(result.blockReason).toBe('steer');
	});

	it('clears blocked state when the pane unblocks', async () => {
		vi.useFakeTimers();
		const dir = makeTempDir();
		const sessionFile = blockedSessionFile(dir);
		registerBlockedEntry(sessionFile, dir);
		vi.mocked(getAgentStatus)
			.mockResolvedValueOnce({ status: 'blocked' })
			.mockResolvedValueOnce({ status: 'idle' })
			.mockResolvedValue({ status: 'gone' });
		const result = makeSingleResult({ label: 'worker-1', paneId: 'ws1:p1' });
		const promise = startPoll(sessionFile, result);
		await driveTimers(promise, 5);
		await expect(promise).resolves.toBe('gone');
		expect(result.blockReason).toBeUndefined();
		expect(result.blockedPreview).toBeUndefined();
		const reg = readRegistry();
		expect(reg.tabs['ws1:worker-1']).toMatchObject({ status: 'running' });
		expect(reg.tabs['ws1:worker-1'].blockReason).toBeUndefined();
		expect(reg.tabs['ws1:worker-1'].blockedPreview).toBeUndefined();
	});
});
