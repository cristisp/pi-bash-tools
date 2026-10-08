import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { flowDirFor, ensureFlow, PREDIGEST_SUBDIR } from './flow.ts';
import { withFileLock } from './registry-store.ts';

// Token-shaped bound: tens of kilobytes instead of a multi-megabyte cap, so a child reads a bounded
// page rather than raw hash lists. The section order in `snapshotText` decides what truncation owes
// the child first.
const MAX_SNAPSHOT_BYTES = 32 * 1024;
const MAX_SNAPSHOT_HISTORY = 10;
const MAX_HASH_BYTES = 8 * 1024 * 1024;
const MAX_HASH_TAIL_BYTES = 1024 * 1024;
const UNAVAILABLE = '(unavailable)';
const SNAPSHOT_BASENAME = 'review-surface';
const SNAPSHOT_NAME = `${SNAPSHOT_BASENAME}.md`;
const SNAPSHOT_HISTORY_DIR = 'surfaces';
const SNAPSHOT_REVISION_PATTERN = new RegExp(`^${SNAPSHOT_BASENAME}-r(\\d+)\\.md$`);
const HASH_BASENAME = 'hashes';
// Sidecars sit directly in the predigest directory, one per snapshot revision.
const HASH_REVISION_PATTERN = new RegExp(`^${HASH_BASENAME}-r(\\d+)\\.json$`);

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
	/** Paths the delta against the previous revision classifies as `changed while dirty` or `newly dirty`. */
	changedPaths: string[];
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
	/** True when the hashing window left a dirty path out, which makes the round-to-round delta partial. */
	incompleteWindow: boolean;
	/** True when a fingerprint input failed or could not be read, so the fingerprint must never be reused. */
	tainted: boolean;
}

export interface FileHash {
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

export type DeltaClass =
	| 'changed while dirty'
	| 'unchanged while dirty'
	| 'newly dirty'
	| 'clean again'
	| 'indeterminate';

const DELTA_CLASSES: DeltaClass[] = [
	'changed while dirty',
	'unchanged while dirty',
	'newly dirty',
	'clean again',
	'indeterminate',
];

/** Round-to-round comparison of the current hash set against the previous revision's sidecar. */
export interface DeltaSummary {
	/** Revision the current hashes are compared against; `undefined` for the first revision. */
	previousRevision?: number;
	/** True when an incomplete hashing window or a missing previous sidecar limits what the classes can claim. */
	partial: boolean;
	classes: Record<DeltaClass, string[]>;
	/** Every path classified `changed while dirty` or `newly dirty`, for the scope-check hint. */
	changedPaths: string[];
}

function emptyClasses(): Record<DeltaClass, string[]> {
	return {
		'changed while dirty': [],
		'unchanged while dirty': [],
		'newly dirty': [],
		'clean again': [],
		indeterminate: [],
	};
}

/** A fully readable hash on one side: its bytes round-tripped and it covered the whole file. */
function usableHash(entry: FileHash): boolean {
	return !entry.partial && !entry.tainted && entry.hash !== UNAVAILABLE;
}

/**
 * Classifies each dirty path present on either side. STRICT: a `partial`, `(unavailable)`, or tainted
 * hash on either side is `indeterminate`, never `unchanged while dirty`, because an unprovable pair
 * must not read as evidence of no change.
 */
function classifyDelta(current: FileHash[], previous: FileHash[]): DeltaSummary {
	const previousByPath = new Map(previous.map((entry) => [entry.path, entry]));
	const classes = emptyClasses();
	const seen = new Set(current.map((entry) => entry.path));
	for (const entry of current) {
		// A deletion is the one unhashable case whose absence is by design: its `(unavailable)` hash is
		// indeterminate even when the path was not dirty in the previous revision, so an unreadable pair
		// never reads as evidence of change direction.
		if (!usableHash(entry)) {
			classes.indeterminate.push(entry.path);
			continue;
		}
		const before = previousByPath.get(entry.path);
		if (before === undefined) {
			classes['newly dirty'].push(entry.path);
			continue;
		}
		if (!usableHash(before)) {
			classes.indeterminate.push(entry.path);
			continue;
		}
		if (before.hash === entry.hash) {
			classes['unchanged while dirty'].push(entry.path);
			continue;
		}
		classes['changed while dirty'].push(entry.path);
	}
	for (const entry of previous) {
		if (!seen.has(entry.path)) classes['clean again'].push(entry.path);
	}
	return {
		previousRevision: undefined,
		partial: false,
		classes,
		changedPaths: [...classes['changed while dirty'], ...classes['newly dirty']],
	};
}

/**
 * Reads the previous revision's hash sidecar. A missing or malformed sidecar yields `undefined`, which
 * the delta marks partial with every current path indeterminate instead of guessing a comparison.
 */
function readHashSidecar(flowId: string, revision: number): FileHash[] | undefined {
	if (!Number.isSafeInteger(revision) || revision <= 0) return undefined;
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(hashSidecarPath(flowId, revision), 'utf8'));
		const hashes = (parsed as { hashes?: unknown })?.hashes;
		if (!Array.isArray(hashes)) return undefined;
		return hashes.map((entry) => {
			const record = entry as Partial<FileHash>;
			return {
				path: String(record.path ?? ''),
				hash: String(record.hash ?? ''),
				partial: record.partial === true,
				tainted: record.tainted === true,
			};
		});
	} catch {
		return undefined;
	}
}

/**
 * Computes the delta of the current hash inputs against the previous revision's sidecar, or marks the
 * first revision with no comparison. A missing sidecar cannot claim a comparison either, so it
 * renders every current path indeterminate with a partial header rather than invented classes.
 */
function deltaSummary(
	flowId: string,
	previousRevision: number | undefined,
	inputs: Omit<SnapshotInputs, 'fingerprint'>,
): DeltaSummary {
	if (previousRevision === undefined)
		// A first revision has no previous hashes: it claims no changed path and no comparison.
		return {
			previousRevision: undefined,
			partial: false,
			classes: emptyClasses(),
			changedPaths: [],
		};
	const classes = emptyClasses();
	const body = readHashSidecar(flowId, previousRevision);
	const delta = body === undefined ? undefined : classifyDelta(inputs.fileHashes, body);
	return {
		previousRevision,
		partial: delta === undefined || inputs.incompleteWindow,
		classes: delta === undefined ? { ...classes, indeterminate: inputs.dirtyPaths } : delta.classes,
		changedPaths:
			delta === undefined
				? []
				: [...delta.classes['changed while dirty'], ...delta.classes['newly dirty']],
	};
}

/** Renders the `## Changes since revision N` section lines for the snapshot. */
function deltaLines(summary: DeltaSummary, revision: number): string[] {
	const header = `## Changes since revision ${summary.previousRevision ?? revision}${summary.partial ? ' (partial)' : ''}`;
	if (summary.previousRevision === undefined) return [header, '', '(no prior revision)'];
	const lines = [header, ''];
	for (const name of DELTA_CLASSES) {
		const paths = summary.classes[name];
		lines.push(paths.length > 0 ? `${name}: ${paths.join(', ')}` : `${name}: (none)`);
	}
	return lines;
}

const HINT_PATH_CAP = 10;

function hintPaths(paths: string[]): string {
	if (paths.length === 0) return '(none)';
	const shown = paths.slice(0, HINT_PATH_CAP).join(', ');
	return paths.length > HINT_PATH_CAP ? `${shown}, ...${paths.length - HINT_PATH_CAP} more` : shown;
}

function normalizedPath(value: string): string {
	return value.trim().replace(/^\.\//, '');
}

/**
 * One non-enforcing hint comparing the ledger's most recent folded `changed_files` claim with the
 * snapshot delta's `changed while dirty` + `newly dirty` set. It never gates, warns, or alters
 * delegation behavior: it is a reading aid only. `deltaPaths === undefined` renders no hint because
 * no delta was computed for this launch, and no folded claim renders `(no claim to compare)`.
 */
export function scopeCheckHint(
	claim: string[] | undefined,
	deltaPaths: string[] | undefined,
): string | undefined {
	if (deltaPaths === undefined) return undefined;
	if (!claim || claim.map(normalizedPath).filter(Boolean).length === 0)
		return 'Scope-check hint (non-enforcing): (no claim to compare)';
	const delta = deltaPaths.map(normalizedPath).filter(Boolean);
	const claimed = claim.map(normalizedPath).filter(Boolean);
	const unaccounted = delta.filter((pathValue) => !claimed.includes(pathValue));
	const missing = claimed.filter((pathValue) => !delta.includes(pathValue));
	if (unaccounted.length === 0 && missing.length === 0)
		return `Scope-check hint (non-enforcing): the changed_files claim matches the snapshot delta (${delta.length} path(s)).`;
	return `Scope-check hint (non-enforcing): the changed_files claim does not match the snapshot delta; changed paths unaccounted for by the claim: ${hintPaths(unaccounted)}; claimed paths missing from the delta: ${hintPaths(missing)}.`;
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
		incompleteWindow: incomplete,
		tainted,
	};
	return { ...inputs, fingerprint: fingerprintOf(inputs) };
}

function snapshotText(
	flowId: string,
	inputs: SnapshotInputs,
	revision: number,
	delta: DeltaSummary,
): string {
	// Blocks separated by one blank line. The delta classes and the diff stat are the mandatory evidence
	// the size cap must never truncate; the raw hashes stay in the `predigest/hashes-r<N>.json` sidecars
	// instead of the child-read snapshot.
	const blocks = [
		[
			'# Review surface snapshot',
			'',
			`flow_id: ${flowId}`,
			`snapshot_fingerprint: ${inputs.fingerprint}`,
			`snapshot_revision: ${revision}`,
			`git_head: ${inputs.head}`,
			`git_root: ${inputs.root}`,
		].join('\n'),
		deltaLines(delta, revision).join('\n'),
		['## Diff stat', '', inputs.stat].join('\n'),
	];
	const statusBlock = ['## Working-tree status', '', inputs.status].join('\n');
	const hunkBlock = ['## Diff hunk headers', '', hunkHeaders(inputs.diff)].join('\n');
	const intact = [...blocks, statusBlock, hunkBlock].join('\n\n') + '\n';
	if (Buffer.byteLength(intact, 'utf8') <= MAX_SNAPSHOT_BYTES) return intact;
	// Degradation follows the truncation priority: the hunk-tail section drops whole rather than being
	// cut into a plausible-looking partial read, then the status tail truncates, and the marker records
	// what was lost while the delta classes and the diff stat survive.
	const base = `${blocks.join('\n\n')}\n\n`;
	const marker = '[review surface snapshot truncated]\n';
	const markerBytes = Buffer.byteLength(`\n${marker}`, 'utf8');
	if (Buffer.byteLength(base, 'utf8') + markerBytes > MAX_SNAPSHOT_BYTES)
		return capUtf8(blocks.join('\n\n'), MAX_SNAPSHOT_BYTES);
	const room = MAX_SNAPSHOT_BYTES - Buffer.byteLength(base, 'utf8') - markerBytes;
	if (Buffer.byteLength(statusBlock, 'utf8') <= room) return `${base}${statusBlock}\n${marker}`;
	const statusHeader = '## Working-tree status\n\n';
	const bodyRoom = room - Buffer.byteLength(statusHeader, 'utf8');
	if (bodyRoom > 0) {
		const kept = Buffer.from(inputs.status, 'utf8').subarray(0, bodyRoom).toString('utf8');
		return `${base}${statusHeader}${kept}\n${marker}`;
	}
	return `${base}\n${marker}`;
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

function hashSidecarPath(flowId: string, revision: number): string {
	return path.join(flowDirFor(flowId), PREDIGEST_SUBDIR, `${HASH_BASENAME}-r${revision}.json`);
}

/** Persists a revision's per-file hash records beside the surfaces history under the same revision name. */
function writeHashSidecar(flowId: string, revision: number, hashes: FileHash[]): void {
	try {
		const target = hashSidecarPath(flowId, revision);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, `${JSON.stringify({ v: 1, revision, hashes }, undefined, 2)}\n`, {
			encoding: 'utf8',
			mode: 0o600,
		});
		pruneHistory(path.dirname(target), HASH_REVISION_PATTERN, (name) =>
			fs.rmSync(path.join(path.dirname(target), name), { force: true }),
		);
	} catch {}
}

/** Retained hash sidecar count; manifests cite the sidecars only when one exists. */
export function retainedHashRevisions(flowId: string): number {
	try {
		return fs
			.readdirSync(path.dirname(hashSidecarPath(flowId, 1)))
			.filter((name) => HASH_REVISION_PATTERN.test(name)).length;
	} catch {
		return 0;
	}
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

/** Keeps the newest `MAX_SNAPSHOT_HISTORY` revision names of one history directory. */
function pruneHistory(directory: string, pattern: RegExp, remove: (name: string) => void): void {
	try {
		// Newest first by revision number, so the oldest matched names are the ones dropped.
		const retained = new Set(
			fs
				.readdirSync(directory)
				.map((name) => ({ name, revision: Number(pattern.exec(name)?.[1]) }))
				.filter((entry) => Number.isSafeInteger(entry.revision) && entry.revision > 0)
				.toSorted((a, b) => b.revision - a.revision)
				.slice(0, MAX_SNAPSHOT_HISTORY)
				.map((entry) => entry.name),
		);
		for (const name of fs.readdirSync(directory)) {
			if (pattern.test(name) && !retained.has(name)) remove(name);
		}
	} catch {}
}

function pruneSnapshotHistory(flowId: string): void {
	pruneHistory(reviewSurfaceHistoryDir(flowId), SNAPSHOT_REVISION_PATTERN, (name) =>
		fs.rmSync(path.join(reviewSurfaceHistoryDir(flowId), name), { force: true }),
	);
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
				// The revision is reused with the section it was written with; the delta degrees are recomputed
				// from the same fingerprint inputs, so the hint stays consistent with the stored section.
				return {
					path: target,
					revision: previous.revision,
					refreshed: false,
					head: inputs.head,
					dirtyPaths: inputs.dirtyPaths,
					fingerprint: inputs.fingerprint,
					changedPaths: deltaSummary(
						flowId,
						previous.revision > 1 ? previous.revision - 1 : undefined,
						inputs,
					).changedPaths,
				};
			}
			const revision = previous ? previous.revision + 1 : 1;
			// The delta is computed before the new sidecar is written, so it always reads the previous
			// revision's records rather than its own.
			const delta = deltaSummary(flowId, previous?.revision, inputs);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			if (previous) retainSnapshot(flowId, previous.revision);
			writeHashSidecar(flowId, revision, inputs.fileHashes);
			fs.writeFileSync(target, snapshotText(flowId, inputs, revision, delta), {
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
				changedPaths: delta.changedPaths,
			};
		});
	} catch {
		return undefined;
	}
}
