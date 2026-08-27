import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerEntry } from '../src/registry.ts';
import { sessionStatsText } from '../src/session-stats.ts';
import { makeRegistryEntry, makeTempDir, stubEnv, userMsg, writeSessionFile } from './helpers.ts';
import { assistantMsg } from './helpers.ts';

let dir: string;
let sessionsDir: string;

beforeEach(() => {
	dir = makeTempDir();
	stubEnv(dir);
	sessionsDir = path.join(dir, 'sessions');
	fs.mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('sessionStatsText', () => {
	it('reports unknown labels', async () => {
		const out = await sessionStatsText('ghost-1');
		expect(out).toContain('No subagent session labeled "ghost-1"');
	});

	it('reports a same-workspace session from another Pi session as unavailable', async () => {
		registerEntry(makeRegistryEntry({ parentSession: '/sess/other.jsonl' }));
		const out = await sessionStatsText('worker-1', '/sess/current.jsonl');
		expect(out).toContain('No subagent session labeled "worker-1" in the active Pi session');
	});

	it('reports stats for a session owned by the active Pi session', async () => {
		const sessionFile = writeSessionFile(dir, 'sessions/subagent-ws1-worker-1.jsonl', []);
		registerEntry(makeRegistryEntry({ sessionFile, parentSession: '/sess/current.jsonl' }));
		const out = await sessionStatsText('worker-1', '/sess/current.jsonl');
		expect(out).toContain('Session ws1:worker-1');
	});

	it('reports context, turns, and lifetime usage from the session file', async () => {
		const sessionFile = writeSessionFile(dir, 'sessions/subagent-ws1-worker-1.jsonl', [
			userMsg('Task: first job'),
			assistantMsg('done first', {
				usage: {
					input: 1000,
					output: 200,
					cacheRead: 500,
					cacheWrite: 100,
					totalTokens: 5000,
					cost: {
						input: 0.001,
						output: 0.002,
						cacheRead: 0.0005,
						cacheWrite: 0.0001,
						total: 0.0036,
					},
				},
			}),
			userMsg('Task: second job'),
			assistantMsg('done second', {
				usage: {
					input: 1500,
					output: 300,
					cacheRead: 600,
					cacheWrite: 200,
					totalTokens: 8000,
					cost: {
						input: 0.002,
						output: 0.003,
						cacheRead: 0.0006,
						cacheWrite: 0.0002,
						total: 0.0058,
					},
				},
			}),
		]);
		registerEntry(makeRegistryEntry({ sessionFile, status: 'done' }));

		const out = await sessionStatsText('worker-1');
		expect(out).toContain('Session ws1:worker-1 (worker, done)');
		expect(out).toContain('context: 8.0k tokens (last turn)');
		expect(out).toContain('turns: 2  reused: 0');
		expect(out).toContain('usage: ↑2.5k ↓500 $0.0094');
		expect(out).not.toContain('R1.1k');
		expect(out).not.toContain('W300');
	});

	it('falls back to registry context when the session file has no usage', async () => {
		const sessionFile = writeSessionFile(dir, 'sessions/subagent-ws1-worker-1.jsonl', [
			userMsg('Task: first job'),
			assistantMsg('done first'),
		]);
		registerEntry(makeRegistryEntry({ sessionFile, status: 'done', contextTokens: 42000 }));
		const out = await sessionStatsText('worker-1');
		expect(out).toContain('context: 42k tokens');
	});

	it('uses registry task history when present', async () => {
		const sessionFile = writeSessionFile(dir, 'sessions/subagent-ws1-worker-1.jsonl', []);
		registerEntry(
			makeRegistryEntry({
				sessionFile,
				status: 'done',
				tasks: ['review auth', 'review api', 'review db'],
			}),
		);
		const out = await sessionStatsText('worker-1');
		expect(out).toContain('recent tasks:');
		expect(out).toContain('1. review auth');
		expect(out).toContain('3. review db');
	});

	it('falls back to user messages in the session file when no task history exists', async () => {
		const sessionFile = writeSessionFile(dir, 'sessions/subagent-ws1-worker-1.jsonl', [
			userMsg('Task: first job'),
			assistantMsg('done first'),
		]);
		registerEntry(makeRegistryEntry({ sessionFile, status: 'done' }));
		const out = await sessionStatsText('worker-1');
		expect(out).toContain('1. Task: first job');
	});

	it('warns on large context and many turns', async () => {
		const messages = [
			userMsg('Task: big context job'),
			assistantMsg('done', {
				usage: {
					input: 1000,
					output: 200,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 150000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
				},
			}),
		];
		for (let i = 0; i < 10; i++) {
			messages.push(userMsg(`Task: extra job ${i}`));
			messages.push(
				assistantMsg(`done ${i}`, {
					usage: {
						input: 100,
						output: 20,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 150000,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
					},
				}),
			);
		}
		const sessionFile = writeSessionFile(dir, 'sessions/subagent-ws1-worker-1.jsonl', messages);
		registerEntry(makeRegistryEntry({ sessionFile, status: 'done', reuseCount: 3 }));
		const out = await sessionStatsText('worker-1');
		expect(out).toContain('Context is large (150k)');
		expect(out).toContain('11 turns across 5 task(s)');
		expect(out).toContain('turns: 11  reused: 3');
		expect(out).toContain('Reused 3 time(s)');
	});

	it('shows the last result preview', async () => {
		const sessionFile = writeSessionFile(dir, 'sessions/subagent-ws1-worker-1.jsonl', []);
		registerEntry(
			makeRegistryEntry({ sessionFile, status: 'done', lastResult: 'All findings fixed.' }),
		);
		const out = await sessionStatsText('worker-1');
		expect(out).toContain('last result: All findings fixed.');
	});

	it('keeps task and result previews compact', async () => {
		const sessionFile = writeSessionFile(dir, 'sessions/subagent-ws1-worker-1.jsonl', []);
		registerEntry(
			makeRegistryEntry({
				sessionFile,
				tasks: ['one', 'two', 'three', 'four', 'x'.repeat(200)],
				lastResult: 'y'.repeat(200),
			}),
		);
		const out = await sessionStatsText('worker-1');
		expect(out).not.toContain('1. one');
		expect(out).toContain('1. three');
		expect(out).toContain('3. ' + 'x'.repeat(80) + '...');
		expect(out).toContain('last result: ' + 'y'.repeat(120) + '...');
	});
});
