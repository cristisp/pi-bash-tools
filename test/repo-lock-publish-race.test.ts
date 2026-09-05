import * as fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireRepositoryWriteLock, repositoryWriteLockPath } from '../src/repo-lock.ts';
import { makeTempDir, stubEnv } from './helpers.ts';

// The one race a real filesystem will not reproduce on demand: every publish loses to a competitor
// while every probe reads the slot as free.
vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>();
	return {
		...actual,
		default: actual,
		linkSync: (target: string, linkPath: string): void => {
			if (typeof linkPath === 'string' && linkPath.endsWith('.lock'))
				throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
			actual.linkSync(target, linkPath);
		},
		statSync: ((...args: unknown[]): unknown => {
			if (typeof args[0] === 'string' && args[0].endsWith('.lock'))
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			return (actual.statSync as (...inner: unknown[]) => unknown)(...args);
		}) as typeof actual.statSync,
	};
});

describe('repository write exclusion when publishing keeps losing', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('runs the command unheld instead of refusing a repository nobody holds', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		const decision = acquireRepositoryWriteLock({
			label: 'worker-1',
			flowId: 'flow-1',
			commandId: 'node_format',
		}) as unknown as { acquired: boolean; handle?: { owned: boolean }; holder?: { label: string } };

		// A refusal that names no holder cannot be acted on, so a free repository is never refused.
		expect(decision.acquired).toBe(true);
		expect(decision.handle?.owned).toBe(false);
		expect(fs.existsSync(repositoryWriteLockPath())).toBe(false);
	});
});
