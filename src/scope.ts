import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { flowDirFor, ensureFlow, PREDIGEST_SUBDIR } from './flow.ts';
import { withFileLock } from './registry-store.ts';

const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_HISTORY = 10;
const MAX_HASH_BYTES = 8 * 1024 * 1024;
const MAX_HASH_TAIL_BYTES = 1024 * 1024;
const UNAVAILABLE = '(unavailable)';
const SNAPSHOT_BASENAME = 'review-surface';
const SNAPSHOT_NAME = `${SNAPSHOT_BASENAME}.md`;
const SNAPSHOT_HISTORY_DIR = 'surfaces';
const SNAPSHOT_REVISION_PATTERN = new RegExp(`^${SNAPSHOT_BASENAME}-r(\\d+)\\.md$`);

function capUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
	const suffix = '\n[review surface snapshot truncated]\n';
	const suffixBytes = Buffer.byteLength(suffix, 'utf8');
	const prefix = Buffer.from(value, 'utf8')
		.subarray(0, Math.max(0, maxBytes - suffixBytes))
		.toString('utf8');
	return `${prefix}${suffix}`;
}

function sha256Hex(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function gitOutput(cwd: string, args: string[]): string {
	try {
		return execFileSync('git', ['-C', cwd, ...args], {
			encoding: 'utf8',
			maxBuffer: 4 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 5000,
		});
	} catch {
		return UNAVAILABLE;
	}
}

function hunkHeaders(diff: string): string {
	// An unreadable section must not look like a tree without hunks.
	if (diff === UNAVAILABLE) return UNAVAILABLE;
	const lines = diff
		.split('\n')
		.filter((line) => line.startsWith('diff --git ') || line.startsWith('@@ '));
	return lines.length > 0 ? lines.join('\n') : '(none)';
}

const MAX_DIRTY_PATHS = 100;
const MAX_DIRTY_PATH_LENGTH = 512;

export interface ReviewSurfaceSnapshot {
	path: string;
	revision: number;
	refreshed: boolean;
	/** Git head recorded with the snapshot, for comparison against published evidence without recomputing state. */
	head: string;
	dirtyPaths: string[];
	/** Content-derived fingerprint of the status codes, the diff stat, the head, the capped delta reads, and every dirty path's bytes and permission bits; unchanged content reuses the revision. */
	fingerprint: string;
}

interface SnapshotInputs {
	status: string;
	stat: string;
	diff: string;
	head: string;
	root: string;
	fingerprint: string;
	dirtyPaths: string[];
	fileHashes: FileHash[];
	/** Digest of the worktree delta against the head, or `UNAVAILABLE` when it could not be read in full. */
	deltaDigest: string;
	/** Digest of the hunk-header read, or `UNAVAILABLE` when it could not be read in full. */
	diffDigest: string;
	/** True when a fingerprint input failed or could not be read, so the fingerprint must never be reused. */
	tainted: boolean;
}

interface FileHash {
	path: string;
	hash: string;
	partial: boolean;
	/** True when an existing path could not be read, so its bytes cannot be tracked. */
	tainted: boolean;
}

/**
 * Bounded content hash. A path within the cap is hashed completely; a larger path is hashed as its first
 * bytes plus a bounded tail window and its size, marked partial so a tail edit still refreshes.
 */
function hashFile(target: string): { hash: string; partial: boolean; tainted: boolean } {
	// A replacement character means the status bytes did not round-trip into a JavaScript string, so the
	// decoded name may address a different file than the one git reported: refuse it instead of hashing
	// the wrong bytes, and let that taint the fingerprint.
	if (target.includes('\uFFFD')) return { hash: UNAVAILABLE, partial: false, tainted: true };
	try {
		const stats = fs.lstatSync(target);
		// A symlink's own content is its target string: following the link would miss a repointed link
		// whose target bytes stayed the same, and would call a broken link unreadable.
		if (stats.isSymbolicLink()) {
			return {
				hash: sha256Hex(`symlink:${fs.readlinkSync(target)}`),
				partial: false,
				tainted: false,
			};
		}
		// A directory has no content to read and a FIFO would block the open until a writer appears, so only
		// a regular file is read; any other existing path taints instead of stalling the snapshot.
		if (!stats.isFile()) return { hash: UNAVAILABLE, partial: false, tainted: true };
		// O_NONBLOCK closes the window between the lstat above and this open, in which the path could be
		// replaced by a FIFO.
		const descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
		try {
			// Verify the opened inode through its own descriptor: the path could have been swapped between the
			// lstat above and this open, and only the descriptor proves what is actually being read.
			const opened = fs.fstatSync(descriptor);
			if (!opened.isFile()) return { hash: UNAVAILABLE, partial: false, tainted: true };
			// The permission bits are hashed with the bytes because git only models the executable bit, so
			// the executable bit of an untracked file would otherwise never reach the fingerprint.
			const digest = createHash('sha256').update(`mode ${opened.mode & 0o7777}\n`);
			const buffer = Buffer.alloc(1024 * 1024);
			let remaining = MAX_HASH_BYTES;
			while (remaining > 0) {
				const read = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), null);
				if (read === 0) break;
				digest.update(buffer.subarray(0, read));
				remaining -= read;
			}
			const hasMore = remaining === 0 && fs.readSync(descriptor, buffer, 0, 1, null) === 1;
			if (!hasMore) return { hash: digest.digest('hex'), partial: false, tainted: false };
			const size = opened.size;
			const tailBytes = Math.min(MAX_HASH_TAIL_BYTES, size);
			const tail = Buffer.alloc(tailBytes);
			fs.readSync(descriptor, tail, 0, tailBytes, size - tailBytes);
			digest.update(`\nsize ${size}\n`).update(tail);
			return { hash: digest.digest('hex'), partial: true, tainted: false };
		} finally {
			fs.closeSync(descriptor);
		}
	} catch {
		// A missing path is the deleted-file case and stays content-independent; anything that exists but
		// cannot be read would hide a content change, so it taints the fingerprint.
		return { hash: UNAVAILABLE, partial: false, tainted: fs.existsSync(target) };
	}
}

/**
 * Content hashes for every dirty path. They are the delta evidence a later review round compares: the
 * snapshot is only reused when this list and the head are unchanged, and two revisions can be compared
 * per file instead of by diff text.
 */
function fileHashes(cwd: string, dirtyPaths: string[]): FileHash[] {
	return dirtyPaths
		.map((relative) => {
			const { hash, partial, tainted } = hashFile(path.join(cwd, relative));
			return { path: relative, hash, partial, tainted };
		})
		.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function fingerprintOf(inputs: Omit<SnapshotInputs, 'fingerprint'>): string {
	const entries = inputs.fileHashes.map(
		({ path: entry, hash, partial }) => `${entry} ${hash}${partial ? ' partial' : ''}`,
	);
	// The preimage is every input that can move the delta evidence: the status codes, the diff stat, the
	// head, both capped delta digests, and each dirty path's name and bytes.
	return sha256Hex(
		[
			inputs.status,
			inputs.stat,
			inputs.head,
			inputs.deltaDigest,
			inputs.diffDigest,
			...entries,
		].join('\n'),
	);
}

function hashLines(hashes: FileHash[]): string {
	const lines = hashes.map(
		({ path: entry, hash, partial }) => `${hash}${partial ? ' (partial)' : ''}  ${entry}`,
	);
	return lines.length > 0 ? lines.join('\n') : '(none)';
}

interface StatusEntry {
	code: string;
	path: string;
}

/**
 * Parses the NUL-separated status. git keeps paths verbatim there, so a path it would C-quote in line
 * mode (non-ASCII bytes, quotes, backslashes) stays hashable, and `--no-renames` keeps one path per
 * entry so a rename arrives as a delete plus an add with both sides addressable.
 */
function statusEntries(status: string): StatusEntry[] {
	const trimmed = status.trim();
	if (trimmed.length === 0 || trimmed === '(clean)' || trimmed === UNAVAILABLE) return [];
	return status
		.split('\0')
		.filter((field) => field.length > 3)
		.map((field) => ({ code: field.slice(0, 2), path: field.slice(3) }))
		.filter(
			(entry, index, all) =>
				entry.path.length > 0 && all.findIndex((other) => other.path === entry.path) === index,
		);
}

/** Hashing window: the first `MAX_DIRTY_PATHS` dirty paths; anything it leaves out makes it incomplete. */
function surfaceWindow(entries: StatusEntry[]): { paths: string[]; incomplete: boolean } {
	const window = entries.slice(0, MAX_DIRTY_PATHS);
	const paths = window
		.filter((entry) => entry.path.length <= MAX_DIRTY_PATH_LENGTH)
		.map((entry) => entry.path);
	return {
		paths,
		// A truncated or length-dropped window cannot prove the tree unchanged, so the caller must not reuse
		// its fingerprint: an edit to a path outside the window would otherwise keep the same revision.
		incomplete: entries.length > paths.length,
	};
}

/** A deletion is the one unhashable case whose content is absent by design rather than unreadable. */
function isDeletion(entries: StatusEntry[], target: string): boolean {
	return entries.some((entry) => entry.path === target && entry.code.includes('D'));
}

function gitRoot(cwd: string): string {
	const toplevel = gitOutput(cwd, ['rev-parse', '--show-toplevel']).trim();
	return toplevel === UNAVAILABLE || toplevel.length === 0 ? cwd : toplevel;
}

function snapshotInputs(root: string): SnapshotInputs {
	// -z keeps paths verbatim instead of C-quoting them, and --no-renames keeps every entry to one path,
	// so a rename is a delete plus an add and both sides stay hashable. Machine-readable status paths are
	// relative to the repository root, which is why every read runs from the root rather than from a
	// delegation directory that may be a subdirectory.
	const rawStatus = gitOutput(root, [
		'-c',
		// status has no --no-color option, so pin the config that would otherwise inject ANSI codes.
		'color.status=never',
		'status',
		'--short',
		'--no-renames',
		'--untracked-files=all',
		'-z',
	]);
	const status = rawStatus.replaceAll('\0', '\n').trimEnd() || '(clean)';
	const rawStat = gitOutput(root, ['diff', 'HEAD', '--stat']);
	const stat = rawStat.trim() || '(none)';
	// The capped binary delta of the worktree against the head is what makes the fingerprint complete for
	// tracked content: unlike the per-file hashes it is not a sample, and it covers mode changes, which
	// neither the status codes nor the diff stat show. `gitOutput` degrades to UNAVAILABLE when the output
	// does not fit the read bound or the read times out, and that taints the fingerprint rather than
	// letting a change it could not read be served as unchanged.
	const rawDelta = gitOutput(root, [
		'-c',
		// Report mode changes even where the platform default would hide them.
		'core.fileMode=true',
		'diff',
		'HEAD',
		'--binary',
		'--no-color',
	]);
	const deltaDigest = rawDelta === UNAVAILABLE ? UNAVAILABLE : sha256Hex(rawDelta);
	// The hunk headers are a projection of the same delta, but their own digest joins the fingerprint
	// rather than relying on that relationship, and a read that fails taints instead of rendering as a
	// tree without hunks. The head is the comparison base here too, so a staged change reaches this
	// section as well as the status and the stat.
	const rawDiff = gitOutput(root, ['diff', 'HEAD', '--no-color', '--unified=0']);
	const diffDigest = rawDiff === UNAVAILABLE ? UNAVAILABLE : sha256Hex(rawDiff);
	const head = gitOutput(root, ['rev-parse', 'HEAD']).trim();
	const entries = statusEntries(rawStatus);
	const { paths: dirtyPaths, incomplete } = surfaceWindow(entries);
	const hashes = fileHashes(root, dirtyPaths);
	// A failed git read of any kind, an incomplete hashing window, or any unaddressable or unreadable path
	// that is not a deletion makes the fingerprint incomplete: reusing it would repeat the same gap and
	// serve a changed tree as unchanged, so the caller forces a new revision instead.
	const tainted =
		rawStatus === UNAVAILABLE ||
		rawStat === UNAVAILABLE ||
		rawDelta === UNAVAILABLE ||
		diffDigest === UNAVAILABLE ||
		head === UNAVAILABLE ||
		incomplete ||
		hashes.some(
			({ hash, tainted: hashTainted, path: hashPath }) =>
				hashTainted || (hash === UNAVAILABLE && !isDeletion(entries, hashPath)),
		);
	const inputs: Omit<SnapshotInputs, 'fingerprint'> = {
		status,
		stat,
		diff: rawDiff,
		head,
		root,
		dirtyPaths,
		fileHashes: hashes,
		deltaDigest,
		diffDigest,
		tainted,
	};
	return { ...inputs, fingerprint: fingerprintOf(inputs) };
}

function snapshotText(flowId: string, inputs: SnapshotInputs, revision: number): string {
	return capUtf8(
		[
			'# Review surface snapshot',
			'',
			`flow_id: ${flowId}`,
			`snapshot_fingerprint: ${inputs.fingerprint}`,
			`snapshot_revision: ${revision}`,
			`git_head: ${inputs.head}`,
			`worktree_delta: ${inputs.deltaDigest}`,
			`worktree_hunks: ${inputs.diffDigest}`,
			`git_root: ${inputs.root}`,
			'',
			// The delta evidence precedes the status text so the size cap truncates context, never hashes.
			'## File hashes',
			'',
			hashLines(inputs.fileHashes),
			'',
			'## Diff stat',
			'',
			inputs.stat,
			'',
			'## Working-tree status',
			'',
			inputs.status,
			'',
			'## Diff hunk headers',
			'',
			hunkHeaders(inputs.diff),
			'',
		].join('\n'),
		MAX_SNAPSHOT_BYTES,
	);
}

function snapshotMetadata(target: string): { fingerprint: string; revision: number } | undefined {
	try {
		const content = fs.readFileSync(target, 'utf8');
		const fingerprint = /^snapshot_fingerprint:\s*(\S+)$/m.exec(content)?.[1];
		const revision = Number(/^snapshot_revision:\s*(\d+)$/m.exec(content)?.[1]);
		if (fingerprint && Number.isSafeInteger(revision) && revision > 0)
			return { fingerprint, revision };
	} catch {}
	return undefined;
}

export function reviewSurfacePath(flowId: string): string {
	return path.join(flowDirFor(flowId), PREDIGEST_SUBDIR, SNAPSHOT_NAME);
}

/** Directory holding the retained earlier revisions of the review surface. */
export function reviewSurfaceHistoryDir(flowId: string): string {
	return path.join(flowDirFor(flowId), PREDIGEST_SUBDIR, SNAPSHOT_HISTORY_DIR);
}

function snapshotHistoryPath(flowId: string, revision: number): string {
	return path.join(reviewSurfaceHistoryDir(flowId), `${SNAPSHOT_BASENAME}-r${revision}.md`);
}

/** Retains the outgoing revision so a later round can compare snapshots instead of trusting a summary. */
function retainSnapshot(flowId: string, revision: number): void {
	const source = reviewSurfacePath(flowId);
	const target = snapshotHistoryPath(flowId, revision);
	try {
		if (fs.existsSync(target) || !fs.existsSync(source)) return;
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.copyFileSync(source, target);
		pruneSnapshotHistory(flowId);
	} catch {}
}

function pruneSnapshotHistory(flowId: string): void {
	try {
		const revisions = fs
			.readdirSync(reviewSurfaceHistoryDir(flowId))
			.map((name) => SNAPSHOT_REVISION_PATTERN.exec(name)?.[1])
			.filter((value): value is string => value !== undefined)
			.map(Number)
			.filter((value) => Number.isSafeInteger(value) && value > 0)
			.toSorted((a, b) => b - a);
		for (const revision of revisions.slice(MAX_SNAPSHOT_HISTORY)) {
			fs.rmSync(snapshotHistoryPath(flowId, revision), { force: true });
		}
	} catch {}
}

/** Counts retained earlier revisions; manifests cite the history directory only when it holds one. */
export function retainedReviewSurfaceRevisions(flowId: string): number {
	try {
		return fs
			.readdirSync(reviewSurfaceHistoryDir(flowId))
			.filter((name) => SNAPSHOT_REVISION_PATTERN.test(name)).length;
	} catch {
		return 0;
	}
}

export function ensureReviewSurface(
	flowId: string | undefined,
	cwd: string,
): ReviewSurfaceSnapshot | undefined {
	if (!flowId || !ensureFlow({ flowId })) return undefined;
	const target = reviewSurfacePath(flowId);
	try {
		return withFileLock(path.join(flowDirFor(flowId), '.lock'), () => {
			// Machine-readable status paths are repository-root relative, so resolve every read there.
			const inputs = snapshotInputs(gitRoot(cwd));
			const previous = snapshotMetadata(target);
			if (!inputs.tainted && previous?.fingerprint === inputs.fingerprint) {
				return {
					path: target,
					revision: previous.revision,
					refreshed: false,
					head: inputs.head,
					dirtyPaths: inputs.dirtyPaths,
					fingerprint: inputs.fingerprint,
				};
			}
			const revision = previous ? previous.revision + 1 : 1;
			fs.mkdirSync(path.dirname(target), { recursive: true });
			if (previous) retainSnapshot(flowId, previous.revision);
			fs.writeFileSync(target, snapshotText(flowId, inputs, revision), {
				encoding: 'utf8',
				mode: 0o600,
			});
			return {
				path: target,
				revision,
				refreshed: true,
				head: inputs.head,
				dirtyPaths: inputs.dirtyPaths,
				fingerprint: inputs.fingerprint,
			};
		});
	} catch {
		return undefined;
	}
}
