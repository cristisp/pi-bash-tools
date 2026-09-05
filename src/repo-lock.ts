import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

/**
 * A repository write that never released, i.e. a child killed mid-command, stops excluding other
 * sessions after this long. The holder is named in the block reason, so a long TTL costs one
 * diagnosis step rather than a wedged flow.
 */
export const REPO_WRITE_LOCK_TTL_MS = 5 * 60_000;

/**
 * How long a lock entry nobody can decode is treated as held. Publish is atomic, so an undecodable
 * entry means corruption rather than an in-flight write, and it self-heals after this grace instead
 * of wedging the repository for the full TTL.
 */
export const REPO_WRITE_LOCK_GRACE_MS = 2_000;

/** Headroom on the inode-age bound, so a holder whose clock runs ahead of ours is never reclaimed early. */
const CLOCK_SLACK_MS = 60_000;

export interface RepositoryWriteHolder {
	readonly token: string;
	readonly label: string;
	readonly flowId?: string;
	readonly commandId: string;
	readonly pid: number;
	readonly acquiredAt: number;
}

export interface RepositoryWriteLockHandle {
	readonly lockPath: string;
	readonly repositoryRoot: string;
	readonly holder: RepositoryWriteHolder;
	/** False when this session already held the lock, so releasing must not free it. */
	readonly owned: boolean;
}

export type RepositoryWriteAcquisition =
	| { readonly acquired: true; readonly handle: RepositoryWriteLockHandle }
	| {
			readonly acquired: false;
			readonly contention: RepositoryWriteContention;
			readonly repositoryRoot: string;
	  };

/**
 * A repository write held by somebody else. The holder is absent when the entry exists but cannot be
 * read, which is a reason to wait without being a name to quote.
 */
export interface RepositoryWriteContention {
	readonly holder?: RepositoryWriteHolder;
	/** Entry timestamp, known from the inode whether or not the entry can be parsed. */
	readonly observedAt: number;
}

type LockProbe =
	| { readonly state: 'free' }
	| {
			readonly state: 'held';
			readonly observedAt: number;
			readonly holder?: RepositoryWriteHolder;
	  };

function isExistenceError(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';
}

function isMissingError(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Nearest ancestor holding a `.git` entry, so two children launched in different subdirectories of
 * one checkout contend for the same lock. Outside any checkout the resolved start is the key, so
 * two unrelated directories do not exclude each other; a working directory that is not a repository
 * still serializes the siblings that share it.
 */
export function repositoryRootOf(start: string = process.cwd()): string {
	let resolved: string;
	try {
		resolved = fs.realpathSync(start);
	} catch {
		return path.resolve(start);
	}
	let current = resolved;
	for (;;) {
		try {
			if (fs.existsSync(path.join(current, '.git'))) return current;
		} catch {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) return resolved;
		current = parent;
	}
}

/**
 * Sessions are identified by label and flow together: labels are allocated per delegating session,
 * so two flows working one checkout produce the same `worker-1` and must still contend.
 */
function isSameSession(
	holder: RepositoryWriteHolder,
	args: { label: string; flowId?: string },
): boolean {
	return holder.label === args.label && (holder.flowId ?? '') === (args.flowId ?? '');
}

export function repositoryWriteLockPath(start?: string): string {
	const root = repositoryRootOf(start);
	const digest = createHash('sha256').update(root).digest('hex').slice(0, 32);
	return path.join(getAgentDir(), 'subagent-herdr', 'repo-locks', `${digest}.lock`);
}

function normalizeHolder(raw: unknown, fallbackAt: number): RepositoryWriteHolder | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
	const value = raw as Record<string, unknown>;
	// A record without a token cannot be released, because release matches on it, and a record without
	// a label cannot be quoted to the sibling that is waiting. Both are treated as corruption so the
	// short grace applies, rather than becoming a hold nobody can name and nobody can clear.
	if (typeof value.token !== 'string' || value.token === '') return undefined;
	if (typeof value.label !== 'string' || value.label === '') return undefined;
	const commandId =
		typeof value.commandId === 'string' && value.commandId ? value.commandId : 'an unknown command';
	const acquiredAt =
		typeof value.acquiredAt === 'number' && Number.isFinite(value.acquiredAt)
			? value.acquiredAt
			: fallbackAt;
	return {
		token: value.token,
		label: value.label,
		...(typeof value.flowId === 'string' && value.flowId ? { flowId: value.flowId } : {}),
		commandId,
		pid: typeof value.pid === 'number' ? value.pid : 0,
		acquiredAt,
	};
}

/**
 * Reads the lock and decides whether it excludes this caller.
 *
 * A record that cannot be read is never assumed free: it is excluded until the inode itself is older than
 * the TTL, on the ground that its writer must have touched the file within its own hold. A record that can
 * be read and named is measured by its own stamp, because that is the clock the holder releases on, and an
 * mtime rewritten by a sync client or a restore cannot make a live holder look expired. Two further rules
 * are the only other ones that ever delete: a record naming no usable holder is corruption and expires after
 * a short grace, and a record whose stamp and inode disagree by more than a whole hold is a backstop for
 * tampered or restored bytes. Every failed unlink reports a hold rather than a free.
 */
function probeLock(lockPath: string, now: number, ttlMs: number): LockProbe {
	let modifiedAt: number;
	try {
		modifiedAt = Math.floor(fs.statSync(lockPath).mtimeMs);
	} catch {
		return { state: 'free' };
	}
	let raw: string;
	try {
		raw = fs.readFileSync(lockPath, 'utf-8');
	} catch (error) {
		if (isMissingError(error)) return { state: 'free' };
		// A read failure says nothing about who holds the repository, and a reader is not entitled to free a
		// hold it cannot inspect, so the entry stays put. Past the bound below we treat an entry nobody can
		// read as abandoned anyway, because an unreadable entry left in place forever would block every
		// publish and switch exclusion off in silence. A live holder whose mtime was rewritten by something
		// other than its own write can be caught here, and that is the cost accepted for not wedging.
		if (now - modifiedAt <= ttlMs + CLOCK_SLACK_MS)
			return { state: 'held', observedAt: modifiedAt };
		try {
			fs.rmSync(lockPath, { force: true });
		} catch {
			return { state: 'held', observedAt: modifiedAt };
		}
		return { state: 'free' };
	}
	let parsed: unknown;
	let decodable = true;
	try {
		parsed = JSON.parse(raw);
	} catch {
		decodable = false;
	}
	const entry = decodable ? normalizeHolder(parsed, modifiedAt) : undefined;
	if (!entry) {
		// Publish is atomic, so bytes nobody can read as a holder are corruption rather than an in-flight
		// write. Nothing live owns such an entry, so it stops excluding anyone once the grace expires
		// instead of wedging the repository for the whole TTL.
		if (now - modifiedAt <= REPO_WRITE_LOCK_GRACE_MS)
			return { state: 'held', observedAt: modifiedAt };
		try {
			fs.rmSync(lockPath, { force: true });
		} catch {
			return { state: 'held', observedAt: modifiedAt };
		}
		return { state: 'free' };
	}
	if (now - entry.acquiredAt > ttlMs) {
		// A stamp that has run out is not a hold to wait out, and reclaiming it is the only way a killed
		// holder cannot wedge a repository for good. A stamp in the future is deliberately still a hold:
		// clock skew is not evidence that the write finished, and deleting on it would let a reader free
		// a live sibling's lock, which is the failure this module exists to prevent.
		try {
			fs.rmSync(lockPath, { force: true });
		} catch {
			return { state: 'held', observedAt: modifiedAt, holder: entry };
		}
		return { state: 'free' };
	}
	if (entry.acquiredAt > now + CLOCK_SLACK_MS && now - modifiedAt > ttlMs + CLOCK_SLACK_MS) {
		// Backstop for tampered or restored bytes, not for clock skew. One machine sets both numbers, the
		// kernel writing mtime and Date.now() writing the stamp, so on a skewed clock they move together and this
		// pair is unreachable; it fires only when something rewrote one of them apart from the other by more than
		// a whole hold plus the slack on both sides. A holder killed with a far-future stamp on a clock later
		// corrected is NOT cleared here, because its mtime went ahead with its stamp, so that hold persists until
		// the reader's clock passes the holder's own expiry. That is the accepted cost of never deleting a stamp
		// merely because it is ahead: see F-013, F-020 and F-023.
		try {
			fs.rmSync(lockPath, { force: true });
		} catch {
			return { state: 'held', observedAt: modifiedAt, holder: entry };
		}
		return { state: 'free' };
	}
	return { state: 'held', observedAt: modifiedAt, holder: entry };
}

/**
 * Removes temporary publishes left behind by a process that died between writing the entry and
 * linking it. Runs on every acquire: the directory holds one entry per repository, so the sweep is
 * cheaper than reasoning about when it last ran.
 */
function sweepStalePublishes(lockPath: string, now: number): void {
	const directory = path.dirname(lockPath);
	const prefix = `${path.basename(lockPath)}.`;
	let names: string[];
	try {
		names = fs.readdirSync(directory);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
		const stale = path.join(directory, name);
		try {
			if (now - Math.floor(fs.statSync(stale).mtimeMs) <= REPO_WRITE_LOCK_TTL_MS) continue;
			fs.unlinkSync(stale);
		} catch {
			/* an entry we cannot stat or remove excludes nothing */
		}
	}
}

/**
 * Publishes a holder atomically: the entry either does not exist or carries the full record, so a
 * reader never mistakes a half-written file for a foreign holder and a holder never blocks on its
 * own publish.
 */
function publishLock(
	lockPath: string,
	holder: RepositoryWriteHolder,
): 'published' | 'collision' | 'error' {
	const tmpPath = `${lockPath}.${holder.token}.tmp`;
	try {
		fs.writeFileSync(tmpPath, JSON.stringify(holder), { encoding: 'utf8', mode: 0o600 });
	} catch {
		return 'error';
	}
	try {
		fs.linkSync(tmpPath, lockPath);
		return 'published';
	} catch (error) {
		if (!isExistenceError(error)) return 'error';
		return 'collision';
	} finally {
		try {
			fs.rmSync(tmpPath, { force: true });
		} catch {
			/* a leftover tmp file excludes nothing */
		}
	}
}

export interface RepositoryWriteLockArgs {
	/** Identity of the calling child session; the same label and flow re-enter their own lock. */
	label: string;
	flowId?: string;
	commandId: string;
	cwd?: string;
	now?: number;
	ttlMs?: number;
}

/**
 * Takes exclusive ownership of a repository for one write-capable command.
 *
 * The exclusion fails open: when the lock store itself is unusable, the command is allowed rather
 * than wedging every write in the flow. The guide rules remain the primary control, and a broken
 * lock store degrades to pre-exclusion behaviour instead of blocking work.
 */
export function acquireRepositoryWriteLock(
	args: RepositoryWriteLockArgs,
): RepositoryWriteAcquisition {
	const now = args.now ?? Date.now();
	const ttlMs = args.ttlMs ?? REPO_WRITE_LOCK_TTL_MS;
	const repositoryRoot = repositoryRootOf(args.cwd);
	const holder: RepositoryWriteHolder = {
		token: randomUUID(),
		label: args.label,
		...(args.flowId ? { flowId: args.flowId } : {}),
		commandId: args.commandId,
		pid: process.pid,
		acquiredAt: now,
	};
	let lockPath = '';
	try {
		lockPath = repositoryWriteLockPath(args.cwd);
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	} catch {
		return { acquired: true, handle: { lockPath: '', repositoryRoot, holder, owned: false } };
	}
	let seen: RepositoryWriteContention | undefined;
	sweepStalePublishes(lockPath, now);
	for (let attempt = 0; attempt < 3; attempt++) {
		const published = publishLock(lockPath, holder);
		if (published === 'published')
			return { acquired: true, handle: { lockPath, repositoryRoot, holder, owned: true } };
		if (published === 'error')
			return { acquired: true, handle: { lockPath: '', repositoryRoot, holder, owned: false } };
		const probe = probeLock(lockPath, now, ttlMs);
		if (probe.state === 'free') continue;
		if (probe.holder && isSameSession(probe.holder, args))
			return {
				acquired: true,
				handle: { lockPath, repositoryRoot, holder: probe.holder, owned: false },
			};
		seen = { holder: probe.holder, observedAt: probe.observedAt };
		break;
	}
	if (seen) return { acquired: false, contention: seen, repositoryRoot };
	// Every attempt found the slot free and still lost the publish, so whoever held it released as fast
	// as we probed. A refusal naming no holder cannot be acted on, so republish once and otherwise let
	// the command run unheld rather than refuse a repository nobody holds.
	if (publishLock(lockPath, holder) === 'published')
		return { acquired: true, handle: { lockPath, repositoryRoot, holder, owned: true } };
	const last = probeLock(lockPath, now, ttlMs);
	if (last.state === 'held')
		return last.holder && isSameSession(last.holder, args)
			? { acquired: true, handle: { lockPath, repositoryRoot, holder: last.holder, owned: false } }
			: {
					acquired: false,
					contention: { holder: last.holder, observedAt: last.observedAt },
					repositoryRoot,
				};
	return { acquired: true, handle: { lockPath: '', repositoryRoot, holder, owned: false } };
}

/**
 * Reports a repository write held by another session, i.e. the state a validation gate would
 * otherwise attest to half-written. Own holds are invisible: a session never blocks on its own write.
 */
export function probeRepositoryWriteLock(args: {
	label: string;
	flowId?: string;
	cwd?: string;
	now?: number;
	ttlMs?: number;
}): RepositoryWriteContention | undefined {
	const now = args.now ?? Date.now();
	let lockPath: string;
	try {
		lockPath = repositoryWriteLockPath(args.cwd);
	} catch {
		return undefined;
	}
	const probe = probeLock(lockPath, now, args.ttlMs ?? REPO_WRITE_LOCK_TTL_MS);
	if (probe.state !== 'held') return undefined;
	if (probe.holder && isSameSession(probe.holder, args)) return undefined;
	return { holder: probe.holder, observedAt: probe.observedAt };
}

export function releaseRepositoryWriteLock(
	handle: RepositoryWriteLockHandle | undefined,
	now: number = Date.now(),
): void {
	if (!handle || !handle.owned || !handle.lockPath) return;
	const probe = probeLock(handle.lockPath, now, Number.MAX_SAFE_INTEGER);
	if (probe.state !== 'held' || probe.holder?.token !== handle.holder.token) return;
	try {
		fs.rmSync(handle.lockPath, { force: true });
	} catch {
		return;
	}
}
