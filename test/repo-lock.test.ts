import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	acquireRepositoryWriteLock,
	probeRepositoryWriteLock,
	releaseRepositoryWriteLock,
	repositoryWriteLockPath,
	repositoryRootOf,
	REPO_WRITE_LOCK_GRACE_MS,
	REPO_WRITE_LOCK_TTL_MS,
	type RepositoryWriteAcquisition,
	type RepositoryWriteContention,
	type RepositoryWriteLockHandle,
} from '../src/repo-lock.ts';
import { makeTempDir, stubEnv } from './helpers.ts';

afterEach(() => {
	vi.restoreAllMocks();
	// Holds are keyed by the real repository root, so a leaked lock would follow the next test.
	if (process.env.PI_CODING_AGENT_DIR) {
		try {
			fs.rmSync(path.dirname(repositoryWriteLockPath()), { recursive: true, force: true });
		} catch {
			/* nothing to clean */
		}
	}
	vi.unstubAllEnvs();
});

type WriteLockView = {
	acquired: boolean;
	contention?: RepositoryWriteContention;
	handle?: RepositoryWriteLockHandle;
};

/** Reads a foreign holder without branching on the discriminated union. */
function holderOf(view: WriteLockView): string | undefined {
	return view.contention?.holder?.label;
}

/**
 * Reads both branches of the discriminated union so assertions stay unconditional.
 */
function viewOf(decision: RepositoryWriteAcquisition): WriteLockView {
	return decision as unknown as WriteLockView;
}

describe('repository write exclusion', () => {
	it('excludes a sibling session for the whole life of the owning hold', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		const first = viewOf(
			acquireRepositoryWriteLock({
				label: 'worker-1',
				flowId: 'flow-1',
				commandId: 'node_format',
				now: 1000,
			}),
		);
		expect(first.acquired).toBe(true);

		const second = viewOf(
			acquireRepositoryWriteLock({
				label: 'worker-2',
				commandId: 'node_lint:fix',
				now: 2000,
			}),
		);
		expect(second.acquired).toBe(false);
		expect(holderOf(second)).toBe('worker-1');
		expect(second.contention?.holder?.commandId).toBe('node_format');
		expect(second.contention?.holder?.flowId).toBe('flow-1');

		expect(probeRepositoryWriteLock({ label: 'worker-2', now: 2000 })?.holder?.label).toBe(
			'worker-1',
		);
		// A session never blocks on a write it owns itself; another flow with the same label does.
		expect(
			probeRepositoryWriteLock({ label: 'worker-1', flowId: 'flow-1', now: 2000 }),
		).toBeUndefined();

		const nested = viewOf(
			acquireRepositoryWriteLock({
				label: 'worker-1',
				flowId: 'flow-1',
				commandId: 'node_format',
				now: 2500,
			}),
		);
		expect(nested.acquired).toBe(true);
		expect(nested.handle?.owned).toBe(false);
		releaseRepositoryWriteLock(nested.handle, 3000);
		expect(probeRepositoryWriteLock({ label: 'worker-2', now: 3000 })?.holder?.label).toBe(
			'worker-1',
		);

		releaseRepositoryWriteLock(first.handle, 3500);
		expect(probeRepositoryWriteLock({ label: 'worker-2', now: 4000 })).toBeUndefined();
		const third = viewOf(
			acquireRepositoryWriteLock({
				label: 'worker-2',
				commandId: 'node_format',
				now: 4500,
			}),
		);
		expect(third.acquired).toBe(true);
		releaseRepositoryWriteLock(third.handle, 5000);
	});

	it('reclaims a hold abandoned by a session that never released it', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		const first = viewOf(
			acquireRepositoryWriteLock({
				label: 'worker-1',
				commandId: 'node_format',
				now: 0,
			}),
		);
		expect(first.acquired).toBe(true);
		const stillHeld = viewOf(
			acquireRepositoryWriteLock({
				label: 'worker-2',
				commandId: 'node_format',
				now: REPO_WRITE_LOCK_TTL_MS,
			}),
		);
		expect(stillHeld.acquired).toBe(false);
		const reclaimed = viewOf(
			acquireRepositoryWriteLock({
				label: 'worker-2',
				commandId: 'node_format',
				now: REPO_WRITE_LOCK_TTL_MS + 1,
			}),
		);
		expect(reclaimed.acquired).toBe(true);
	});

	it('treats a lock entry it cannot describe as held until it ages out', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		const lockPath = repositoryWriteLockPath();
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		fs.writeFileSync(lockPath, 'not json', { encoding: 'utf-8' });

		const blocked = viewOf(
			acquireRepositoryWriteLock({ label: 'worker-2', commandId: 'node_format' }),
		);
		expect(blocked.acquired).toBe(false);
		expect(probeRepositoryWriteLock({ label: 'worker-2' })?.holder).toBeUndefined();
	});

	// A reader that cannot parse an entry may still be looking at a live holder, so it must never be
	// the one that frees it.
	it('never frees a holder it cannot read, only declines to name it', (ctx) => {
		const dir = makeTempDir();
		stubEnv(dir);
		const lockPath = repositoryWriteLockPath();
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		fs.writeFileSync(
			lockPath,
			JSON.stringify({
				token: 'unreadable',
				label: 'worker-1',
				commandId: 'node_format',
				pid: 1,
				acquiredAt: Date.now(),
			}),
		);
		const original = fs.readFileSync(lockPath, 'utf-8');
		fs.chmodSync(lockPath, 0o000);
		let readError: unknown;
		try {
			fs.readFileSync(lockPath, 'utf-8');
		} catch (error) {
			readError = error;
		}
		const simulated = readError !== undefined;
		// A runner whose privileges ignore the mode bit cannot produce a read failure, and a silent early
		// return there would report a pass that never exercised the branch, so the skip is announced.
		if (!simulated) {
			fs.chmodSync(lockPath, 0o600);
			ctx.skip();
		}
		expect((readError as NodeJS.ErrnoException).code).toBe('EACCES');

		const blocked = viewOf(
			acquireRepositoryWriteLock({ label: 'worker-2', commandId: 'node_format' }),
		);
		expect(blocked.acquired).toBe(false);
		expect(blocked.contention?.holder).toBeUndefined();
		expect(blocked.contention?.observedAt).toBeGreaterThan(0);
		fs.chmodSync(lockPath, 0o600);
		expect(fs.readFileSync(lockPath, 'utf-8')).toBe(original);
	});

	// A clock running ahead of ours is not evidence that a write finished, so it must not cost the holder
	// its lock, and a record that is not a holder record must not become one.
	it('keeps a hold whose stamp is ahead of our clock', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		const lockPath = repositoryWriteLockPath();
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		fs.writeFileSync(
			lockPath,
			JSON.stringify({
				token: 'ahead-of-us',
				label: 'worker-1',
				commandId: 'node_format',
				pid: 1,
				acquiredAt: Date.now() + 120_000,
			}),
		);

		const blocked = viewOf(
			acquireRepositoryWriteLock({ label: 'worker-2', commandId: 'node_format' }),
		);
		expect(blocked.acquired).toBe(false);
		expect(holderOf(blocked)).toBe('worker-1');
		expect(fs.existsSync(lockPath)).toBe(true);

		// Release matches on the token, so a sibling that believes it owns the slot cannot clear it.
		releaseRepositoryWriteLock({
			lockPath,
			repositoryRoot: repositoryRootOf(),
			holder: {
				token: 'not-the-holder',
				label: 'worker-2',
				commandId: 'node_format',
				pid: 2,
				acquiredAt: Date.now(),
			},
			owned: true,
		});
		expect(fs.existsSync(lockPath)).toBe(true);
	});

	// An entry nobody can read has no stamp anyone can check, so the inode is the only clock left, and
	// leaving it in place forever would block every publish and switch exclusion off without saying so.
	// The stamp is deliberately live so a runner that ignores the mode bit fails this test instead of
	// quietly passing it through the content branch.
	it('clears an unreadable entry on inode age alone', (ctx) => {
		const dir = makeTempDir();
		stubEnv(dir);
		const lockPath = repositoryWriteLockPath();
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		fs.writeFileSync(
			lockPath,
			JSON.stringify({
				token: 'abandoned',
				label: 'worker-1',
				commandId: 'node_format',
				pid: 1,
				acquiredAt: Date.now(),
			}),
		);
		fs.chmodSync(lockPath, 0o000);
		let readError: unknown;
		try {
			fs.readFileSync(lockPath, 'utf-8');
		} catch (error) {
			readError = error;
		}
		const simulated = readError !== undefined;
		if (!simulated) {
			fs.chmodSync(lockPath, 0o600);
			ctx.skip();
		}
		const aged = Date.now() - REPO_WRITE_LOCK_TTL_MS - 61_000;
		fs.utimesSync(lockPath, new Date(aged), new Date(aged));

		const acquired = viewOf(
			acquireRepositoryWriteLock({ label: 'worker-2', commandId: 'node_format' }),
		);
		expect(acquired.acquired).toBe(true);
		expect(acquired.handle?.owned).toBe(true);
		fs.chmodSync(lockPath, 0o600);
		expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).token).not.toBe('abandoned');
		if (acquired.handle?.owned) releaseRepositoryWriteLock(acquired.handle);
	});

	// A mtime rewritten by something other than the holder's own write - a sync client, a restore, an
	// mtime-normalising tool - must not cost an identifiable live holder its lock. This is the branch the
	// fix above sits in front of, so it is the test that keeps that fix honest.
	it('keeps a live hold whose mtime was rewritten behind its stamp', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		const lockPath = repositoryWriteLockPath();
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		fs.writeFileSync(
			lockPath,
			JSON.stringify({
				token: 'mtime-rewritten',
				label: 'worker-1',
				commandId: 'node_format',
				pid: 1,
				acquiredAt: Date.now(),
			}),
		);
		const aged = Date.now() - REPO_WRITE_LOCK_TTL_MS - 61_000;
		fs.utimesSync(lockPath, new Date(aged), new Date(aged));

		const blocked = viewOf(
			acquireRepositoryWriteLock({ label: 'worker-2', commandId: 'node_format' }),
		);
		expect(blocked.acquired).toBe(false);
		expect(holderOf(blocked)).toBe('worker-1');
		expect(fs.existsSync(lockPath)).toBe(true);

		const contention = probeRepositoryWriteLock({ label: 'worker-2' });
		expect(contention?.holder?.label).toBe('worker-1');
	});

	// One machine writes the mtime and the stamp, so an inode dragged behind an ahead stamp is restored or
	// tampered bytes rather than clock skew. Both halves are pinned so neither can be widened silently.
	it('reclaims a forward stamp only when its inode disagrees by a whole hold', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		const lockPath = repositoryWriteLockPath();
		const now = Date.now();
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		const future = {
			token: 'future',
			label: 'worker-1',
			commandId: 'node_format',
			pid: 1,
			acquiredAt: now + 120_000,
		};

		fs.writeFileSync(lockPath, JSON.stringify(future));
		const aged = new Date(Math.floor((now - REPO_WRITE_LOCK_TTL_MS - 61_000) / 1000));
		fs.utimesSync(lockPath, aged, aged);
		const acquired = viewOf(
			acquireRepositoryWriteLock({ label: 'worker-2', commandId: 'node_format' }),
		);
		expect(acquired.acquired).toBe(true);
		expect(acquired.handle?.owned).toBe(true);
		if (acquired.handle?.owned) releaseRepositoryWriteLock(acquired.handle);

		// Same stamp against an honest mtime is a holder on a fast clock, and the backstop must keep out.
		fs.writeFileSync(lockPath, JSON.stringify(future));
		const held = viewOf(
			acquireRepositoryWriteLock({ label: 'worker-2', commandId: 'node_format' }),
		);
		expect(held.acquired).toBe(false);
		expect(holderOf(held)).toBe('worker-1');
		expect(fs.existsSync(lockPath)).toBe(true);
	});

	// Valid JSON that carries neither a token to release by nor a label to quote is corruption, so it
	// self-heals on the short grace and is never named to a sibling as somebody's session.
	it('treats a JSON object that is not a holder record as corruption', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		const lockPath = repositoryWriteLockPath();
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		fs.writeFileSync(lockPath, '{"x":1}');

		const blocked = viewOf(
			acquireRepositoryWriteLock({ label: 'worker-2', commandId: 'node_format' }),
		);
		expect(blocked.acquired).toBe(false);
		expect(blocked.contention?.holder).toBeUndefined();

		const aged = Date.now() - REPO_WRITE_LOCK_GRACE_MS - 1_000;
		fs.utimesSync(lockPath, new Date(aged), new Date(aged));
		const reclaimed = viewOf(
			acquireRepositoryWriteLock({ label: 'worker-2', commandId: 'node_format' }),
		);
		expect(reclaimed.acquired).toBe(true);
		if (reclaimed.handle?.owned) releaseRepositoryWriteLock(reclaimed.handle);
	});
	// A publish that died between writing the entry and linking it leaves a tmp file behind; it excludes
	// nothing, so it is swept rather than accumulating in a directory shared by every repository.
	it('sweeps a stale publish without touching a live one', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		const lockPath = repositoryWriteLockPath();
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		const stale = `${lockPath}.deadbeef.tmp`;
		const fresh = `${lockPath}.cafebabe.tmp`;
		fs.writeFileSync(stale, '{}');
		fs.writeFileSync(fresh, '{}');
		const aged = Date.now() - REPO_WRITE_LOCK_TTL_MS - 1_000;
		fs.utimesSync(stale, new Date(aged), new Date(aged));

		const acquired = viewOf(
			acquireRepositoryWriteLock({ label: 'worker-1', commandId: 'node_format' }),
		);
		expect(acquired.acquired).toBe(true);
		expect(fs.existsSync(stale)).toBe(false);
		expect(fs.existsSync(fresh)).toBe(true);
		if (acquired.handle?.owned) releaseRepositoryWriteLock(acquired.handle);
	});

	it('distinguishes two flows that allocate the same label', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		const first = viewOf(
			acquireRepositoryWriteLock({
				label: 'worker-1',
				flowId: 'flow-1',
				commandId: 'node_format',
				now: 1000,
			}),
		);
		expect(first.acquired).toBe(true);

		// Labels are allocated per delegating session, so two flows on one checkout both own a worker-1.
		const twin = viewOf(
			acquireRepositoryWriteLock({
				label: 'worker-1',
				flowId: 'flow-2',
				commandId: 'node_format',
				now: 1500,
			}),
		);
		expect(twin.acquired).toBe(false);
		expect(
			probeRepositoryWriteLock({ label: 'worker-1', flowId: 'flow-2', now: 1500 })?.holder?.flowId,
		).toBe('flow-1');
		expect(
			probeRepositoryWriteLock({ label: 'worker-1', flowId: 'flow-1', now: 1500 }),
		).toBeUndefined();
		releaseRepositoryWriteLock(first.handle, 1600);
	});

	it('stops trusting an entry nobody can decode once the publish grace passes', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		const lockPath = repositoryWriteLockPath();
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		fs.writeFileSync(lockPath, 'not json', { encoding: 'utf-8' });

		const fresh = viewOf(
			acquireRepositoryWriteLock({ label: 'worker-2', commandId: 'node_format' }),
		);
		expect(fresh.acquired).toBe(false);

		const stale = Date.now() - REPO_WRITE_LOCK_GRACE_MS - 1_000;
		fs.utimesSync(lockPath, new Date(stale), new Date(stale));
		const reclaimed = viewOf(
			acquireRepositoryWriteLock({ label: 'worker-2', commandId: 'node_format' }),
		);
		expect(reclaimed.acquired).toBe(true);
		releaseRepositoryWriteLock(reclaimed.handle);
	});

	it('keys a directory outside any checkout to itself instead of to the filesystem root', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		const left = makeTempDir();
		const right = makeTempDir();
		expect(repositoryRootOf(left)).toBe(fs.realpathSync(left));
		expect(repositoryRootOf(left)).not.toBe(repositoryRootOf(right));

		const first = viewOf(
			acquireRepositoryWriteLock({ label: 'worker-1', commandId: 'node_format', cwd: left }),
		);
		const second = viewOf(
			acquireRepositoryWriteLock({ label: 'worker-1', commandId: 'node_format', cwd: right }),
		);
		expect(first.acquired).toBe(true);
		expect(second.acquired).toBe(true);
		expect(probeRepositoryWriteLock({ label: 'worker-2', cwd: left })?.holder?.label).toBe(
			'worker-1',
		);
		expect(probeRepositoryWriteLock({ label: 'worker-2', cwd: right })?.holder?.label).toBe(
			'worker-1',
		);
		releaseRepositoryWriteLock(first.handle);
		releaseRepositoryWriteLock(second.handle);
	});

	it('allows the command when the lock store itself is unusable', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		// The lock directory is occupied by a regular file, so no entry can be created or read.
		const locksDir = path.dirname(repositoryWriteLockPath());
		fs.mkdirSync(path.dirname(locksDir), { recursive: true });
		fs.writeFileSync(locksDir, 'not a directory', { encoding: 'utf-8' });

		const acquired = viewOf(
			acquireRepositoryWriteLock({ label: 'worker-1', commandId: 'node_format' }),
		);
		expect(acquired.acquired).toBe(true);
		expect(acquired.handle?.owned).toBe(false);
		expect(probeRepositoryWriteLock({ label: 'worker-2' })).toBeUndefined();
	});

	it('never releases a hold another session owns', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		const first = acquireRepositoryWriteLock({ label: 'worker-1', commandId: 'node_format' });
		expect(first.acquired).toBe(true);
		if (first.acquired) {
			releaseRepositoryWriteLock({
				...first.handle,
				holder: { ...first.handle.holder, token: 'x' },
			});
		}
		expect(probeRepositoryWriteLock({ label: 'worker-2' })?.holder?.label).toBe('worker-1');
		if (first.acquired) releaseRepositoryWriteLock(first.handle);
		expect(probeRepositoryWriteLock({ label: 'worker-2' })).toBeUndefined();
	});
});
