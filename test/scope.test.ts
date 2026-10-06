import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flowDirFor, flowReportsDir } from '../src/flow.ts';
import { ensureReviewSurface, reviewSurfaceHistoryDir } from '../src/scope.ts';
import { buildReadManifest, recordKnownRefs, writeReadManifest } from '../src/manifest.ts';
import { resolveDelegation, sanitizeReviewScope } from '../src/delegation.ts';
import { makeTempDir, stubEnv } from './helpers.ts';

afterEach(() => vi.restoreAllMocks());

describe('review surface and read manifests', () => {
	it('creates one flow-level review surface and a scoped manifest', async () => {
		const agentDir = makeTempDir();
		stubEnv(agentDir);
		const flowId = 'flow-scope-test';
		const surface = ensureReviewSurface(flowId, process.cwd());
		expect(surface).toBeDefined();
		expect(fs.existsSync(surface!.path)).toBe(true);
		expect(surface!.revision).toBe(1);
		expect(surface!.refreshed).toBe(true);
		const initial = fs.readFileSync(surface!.path, 'utf8');
		const second = ensureReviewSurface(flowId, process.cwd());
		expect(second?.path).toBe(surface?.path);
		expect(second?.revision).toBe(surface?.revision);
		expect(second?.refreshed).toBe(false);
		expect(fs.readFileSync(surface!.path, 'utf8')).toBe(initial);

		const delegation = {
			delegationId: 'delegation-scope-test',
			flowId,
			role: 'reviewer',
			evidenceScope: 'flow' as const,
			scope: { paths: ['src/run.ts'], hunks: ['@@ -1,2 +1,3 @@'], outOfScope: ['docs'] },
			reviewSurfacePath: surface?.path,
			dirtyPaths: surface?.dirtyPaths,
		};
		const manifest = buildReadManifest(delegation);
		expect(manifest.artifactPaths).toContain(surface!.path);
		expect(manifest.allowedPaths).toEqual(['src/run.ts']);
		expect(manifest.dirtyPaths).toEqual(
			surface!.dirtyPaths.length > 0 ? surface!.dirtyPaths : undefined,
		);
		expect(
			buildReadManifest({
				...delegation,
				scope: { paths: ['src//run.ts', '../secret', '/tmp/secret'] },
			}).allowedPaths,
		).toEqual(['src/run.ts']);
		expect(manifest.doNotReread).toEqual([surface!.path]);

		const temp = makeTempDir();
		const written = await writeReadManifest(temp, delegation);
		expect(written.manifest.manifestPath).toBe(path.join(temp, 'read-manifest.json'));
		expect(written.manifest.persistedPath).toContain(
			'predigest/manifests/delegation-scope-test.json',
		);
		expect(JSON.parse(fs.readFileSync(written.path, 'utf8')).allowedPaths).toEqual(['src/run.ts']);
		expect(fs.existsSync(written.manifest.persistedPath as string)).toBe(true);
	});

	it('records the git head alongside the review-surface fingerprint', () => {
		const agentDir = makeTempDir();
		stubEnv(agentDir);
		const flowId = 'flow-git-head';
		const surface = ensureReviewSurface(flowId, process.cwd());
		expect(surface).toBeDefined();
		expect(surface!.head).toMatch(/^[0-9a-f]{40}$/);
		const content = fs.readFileSync(surface!.path, 'utf8');
		expect(content).toContain(`git_head: ${surface!.head}`);
		expect(content).toMatch(/^snapshot_fingerprint: [0-9a-f]{64}$/m);
		const second = ensureReviewSurface(flowId, process.cwd());
		expect(second?.head).toBe(surface?.head);
		expect(second?.refreshed).toBe(false);
	});

	it('carries prior flow refs with verdict and freshness in read manifests', () => {
		const agentDir = makeTempDir();
		stubEnv(agentDir);
		const flowId = 'flow-known-refs';
		recordKnownRefs({
			flowId,
			delegationId: 'turn-1',
			at: 1000,
			refs: [
				{
					ref: 'vr_older',
					verdict: 'passed',
					reused: false,
					lookup: false,
					head: 'deadbeefcafe',
					stateDigest: 'ab12cd34ef56',
				},
				{
					ref: 'vr_resolved',
					verdict: 'passed',
					reused: true,
					lookup: true,
					repositoryStateStatus: 'matches',
				},
				// Refs minted under a different flow are not resolvable here.
				{ ref: 'vr_other_flow', reused: true, lookup: true, flowId: 'flow-other' },
				// Ambiguous provenance is dropped.
				{ ref: 'vr_conflict', reused: true, lookup: true, flowIdConflict: true },
			],
		});
		recordKnownRefs({
			flowId,
			delegationId: 'turn-2',
			at: 2000,
			refs: [{ ref: 'vr_older', verdict: 'failed', reused: true, lookup: true }],
		});

		const manifest = buildReadManifest({
			delegationId: 'consumer',
			flowId,
			role: 'validator',
			evidenceScope: 'flow',
		});
		expect(manifest.knownRefs).toEqual([
			{ ref: 'vr_resolved', verdict: 'passed', reused: true, repositoryStateStatus: 'matches' },
			{ ref: 'vr_older', verdict: 'failed', reused: true },
		]);

		const withoutFlow = buildReadManifest({
			delegationId: 'consumer',
			role: 'validator',
			evidenceScope: 'flow',
		});
		expect(withoutFlow.knownRefs).toBeUndefined();
	});

	it('carries published read refs as kind-read hints and drops unpublished ones', () => {
		const agentDir = makeTempDir();
		stubEnv(agentDir);
		const flowId = 'flow-read-refs';
		recordKnownRefs({
			flowId,
			delegationId: 'turn-1',
			at: 1000,
			refs: [],
			readRefs: [
				{ ref: 'rr_published', reused: false, publication: 'published', flowId },
				// Published-looking refs without producer flow provenance are process-scoped or ambiguous.
				{ ref: 'rr_no_flow', reused: false, publication: 'published' },
				{ ref: 'rr_other_flow', reused: false, publication: 'published', flowId: 'flow-other' },
				// Unpublished or failed-publication reads cannot resolve from a sibling lookup.
				{ ref: 'rr_unpublished', reused: false, flowId },
				{
					ref: 'rr_failed',
					reused: false,
					publication: 'failed',
					publicationReason: 'denied',
					flowId,
				},
				{
					ref: 'rr_conflict',
					reused: true,
					publication: 'published',
					flowId,
					flowIdConflict: true,
				},
			],
		});

		const manifest = buildReadManifest({
			delegationId: 'consumer',
			flowId,
			role: 'worker',
			evidenceScope: 'flow',
		});
		expect(manifest.knownRefs).toEqual([{ ref: 'rr_published', kind: 'read', reused: false }]);
	});

	it('filters read refs across fresh producer and consumer processes', () => {
		const agentDir = makeTempDir();
		const scriptPath = path.join(agentDir, 'manifest-process-test.mjs');
		const flowId = 'flow-fresh-process';
		const manifestModule = path.resolve('src/manifest.ts');
		fs.writeFileSync(
			scriptPath,
			`const { buildReadManifest, recordKnownRefs } = await import(${JSON.stringify(manifestModule)});
const flowId = ${JSON.stringify(flowId)};
if (process.argv[2] === 'write') {
  recordKnownRefs({
    flowId,
    delegationId: 'producer-process',
    refs: [],
    readRefs: [
      { ref: 'rr_published', reused: false, publication: 'published', flowId },
      { ref: 'rr_no_flow', reused: false, publication: 'published' },
      { ref: 'rr_other_flow', reused: false, publication: 'published', flowId: 'flow-other' },
      { ref: 'rr_unpublished', reused: false, flowId },
      { ref: 'rr_failed', reused: false, publication: 'failed', flowId },
      { ref: 'rr_conflict', reused: false, publication: 'published', flowId, flowIdConflict: true },
    ],
  });
} else {
  const manifest = buildReadManifest({
    delegationId: 'consumer-process',
    flowId,
    role: 'worker',
    evidenceScope: 'flow',
  });
  process.stdout.write(JSON.stringify(manifest.knownRefs ?? []));
}
`,
		);
		const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
		const producer = spawnSync(
			process.execPath,
			['--experimental-strip-types', scriptPath, 'write'],
			{
				cwd: path.resolve('.'),
				env,
				encoding: 'utf8',
			},
		);
		expect(producer.status).toBe(0);
		const consumer = spawnSync(
			process.execPath,
			['--experimental-strip-types', scriptPath, 'read'],
			{
				cwd: path.resolve('.'),
				env,
				encoding: 'utf8',
			},
		);
		expect(consumer.status).toBe(0);
		expect(JSON.parse(consumer.stdout)).toEqual([
			{ ref: 'rr_published', kind: 'read', reused: false },
		]);
		fs.rmSync(agentDir, { recursive: true, force: true });
	});

	it('keeps manifests working when persisted refs are malformed', () => {
		const agentDir = makeTempDir();
		stubEnv(agentDir);
		const flowId = 'flow-bad-refs';
		recordKnownRefs({
			flowId,
			delegationId: 'turn-bad',
			refs: [{ ref: 'vr_keep', verdict: 'passed', reused: false, lookup: false }],
		});
		fs.writeFileSync(
			path.join(flowDirFor(flowId), 'predigest', 'refs', 'corrupt.json'),
			'{not json',
		);
		fs.writeFileSync(
			path.join(flowDirFor(flowId), 'predigest', 'refs', 'badshape.json'),
			JSON.stringify({ v: 1, at: 1, refs: [{ ref: 'vr_bad', reused: 'yes' }, 'vr_worse'] }),
		);
		fs.writeFileSync(
			path.join(flowDirFor(flowId), 'predigest', 'refs', 'legacy-read.json'),
			JSON.stringify({
				v: 1,
				flowId,
				at: 2,
				refs: [{ ref: 'rr_legacy', kind: 'read', reused: false }],
			}),
		);

		const manifest = buildReadManifest({
			delegationId: 'consumer',
			flowId,
			role: 'validator',
			evidenceScope: 'flow',
		});
		expect(manifest.knownRefs).toEqual([{ ref: 'vr_keep', verdict: 'passed', reused: false }]);
	});

	it('canonicalizes safe scope paths and drops traversal or absolute paths', () => {
		expect(
			sanitizeReviewScope({
				paths: [
					'./src//run.ts',
					'src/./run.ts',
					'../secrets',
					'/tmp/secrets',
					'C:/secrets',
					'src/\u0000run.ts',
				],
				hunks: ['src/run.ts@H1'],
			}),
		).toEqual({ paths: ['src/run.ts'], hunks: ['src/run.ts@H1'] });
	});

	it('bounds prior report paths in read manifests', () => {
		const agentDir = makeTempDir();
		stubEnv(agentDir);
		const flowId = 'flow-manifest-bounds';
		const reportsDir = flowReportsDir(flowId);
		fs.mkdirSync(reportsDir, { recursive: true });
		for (let index = 0; index < 105; index += 1)
			fs.writeFileSync(
				path.join(reportsDir, `report-${String(index).padStart(3, '0')}.md`),
				'report',
			);
		const manifest = buildReadManifest({
			delegationId: 'bounded',
			flowId,
			role: 'reviewer',
			evidenceScope: 'flow',
		});
		expect(manifest.priorReports).toHaveLength(100);
		expect(manifest.priorReports.every((reportPath) => reportPath.length <= 512)).toBe(true);
	});

	it('removes a temporary manifest when persisted writing fails', async () => {
		const agentDir = makeTempDir();
		stubEnv(agentDir);
		const temp = makeTempDir();
		vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('persist failed'));
		await expect(
			writeReadManifest(temp, {
				delegationId: 'manifest-failure',
				flowId: 'flow-failure',
				role: 'reviewer',
				evidenceScope: 'flow',
			}),
		).rejects.toThrow('persist failed');
		expect(fs.existsSync(path.join(temp, 'read-manifest.json'))).toBe(false);
	});

	it('accepts only the flow-owned review surface path', () => {
		const agentDir = makeTempDir();
		stubEnv(agentDir);
		const flowId = 'flow-surface-validation';
		const expected = ensureReviewSurface(flowId, process.cwd());
		const base = { role: 'reviewer', flowId, parentSession: 'root-session' };
		expect(
			resolveDelegation({
				...base,
				orchestration: { reviewSurfacePath: expected?.path },
			}).reviewSurfacePath,
		).toBe(expected?.path);
		expect(
			resolveDelegation({
				...base,
				orchestration: { reviewSurfacePath: '/tmp/review-surface.md' },
			}).reviewSurfacePath,
		).toBeUndefined();
	});
});

const GIT_TEST_TIMEOUT_MS = 30_000;

function gitIn(dir: string, args: string[]) {
	return spawnSync('git', args, {
		cwd: dir,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore'],
		// A global git config must not leak into these repositories. Commit signing in particular can block
		// on a locked or unavailable signing agent, which would leave the repository without the commit the
		// test depends on. The bound keeps such a block visible as a failed test instead of a hung suite.
		env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull },
		timeout: 10_000,
	});
}

function commitAll(dir: string, message: string, allowEmpty = false): void {
	gitIn(dir, ['add', '-A']);
	gitIn(dir, [
		'-c',
		'user.email=test@example.com',
		'-c',
		'user.name=Test',
		'-c',
		'commit.gpgsign=false',
		'commit',
		...(allowEmpty ? ['--allow-empty'] : []),
		'-m',
		message,
	]);
}

function gitRepo(): string {
	const dir = fs.realpathSync(makeTempDir());
	gitIn(dir, ['init']);
	commitAll(dir, 'init', true);
	return dir;
}

/** One unique line of a bulky file, so a diff of it cannot share context and exceeds the read bound. */
function bigFileLine(prefix: string, index: number): string {
	return `${prefix}-${index}-${'x'.repeat(80)}\n`;
}

/** A bulky file body built from unique lines under the given prefix. */
function bigFileBody(prefix: string): string {
	return Array.from({ length: 30_000 }, (_, index) => bigFileLine(prefix, index)).join('');
}

/**
 * Writes a `git` wrapper into `dir` that fails the hunk-header read, so one failing read of the delta can
 * be isolated from the reads that still succeed. Returns the directory to put first on PATH.
 */
function fakeGitBin(dir: string): string {
	const real = (process.env.PATH ?? '')
		.split(path.delimiter)
		.map((entry) => path.join(entry, 'git'))
		.find((candidate) => fs.existsSync(candidate));
	if (!real) throw new Error('git is not on PATH');
	fs.writeFileSync(
		path.join(dir, 'git'),
		`#!/bin/sh\nfor arg in "$@"; do\n\tif [ "$arg" = "--unified=0" ]; then\n\t\techo "forced hunk read failure" >&2\n\t\texit 128\n\tfi\ndone\nexec "${real}" "$@"\n`,
		{ mode: 0o755 },
	);
	return dir;
}

/** Parses the snapshot's `## File hashes` section into path -> hash. */
function surfaceHashes(content: string): Map<string, string> {
	const section = content.split('## File hashes\n')[1]?.split('\n## ')[0] ?? '';
	const hashes = new Map<string, string>();
	for (const line of section.split('\n')) {
		const match = /^(\S+)(?: \(partial\))?  (.+)$/.exec(line);
		if (match) hashes.set(match[2], match[1]);
	}
	return hashes;
}

describe('review surface content hashes', () => {
	it(
		'hashes every dirty path and refreshes on a same-shape content change',
		() => {
			const agentDir = makeTempDir();
			stubEnv(agentDir);
			const repo = gitRepo();
			fs.writeFileSync(path.join(repo, 'a.txt'), 'aaa\n');
			fs.writeFileSync(path.join(repo, 'b.txt'), 'bbb\n');
			const flowId = 'flow-surface-hashes';
			const first = ensureReviewSurface(flowId, repo);
			expect(first?.refreshed).toBe(true);
			expect(first?.revision).toBe(1);
			const firstHashes = surfaceHashes(fs.readFileSync(first!.path, 'utf8'));
			expect(firstHashes.size).toBe(2);
			expect(firstHashes.get('a.txt')).toMatch(/^[0-9a-f]{64}$/);
			expect(firstHashes.get('a.txt')).not.toBe(firstHashes.get('b.txt'));
			expect(fs.readFileSync(first!.path, 'utf8')).toMatch(/^worktree_hunks: [0-9a-f]{64}$/m);

			// Same byte length, same diff stat, same head: a status+stat+head fingerprint cannot see this.
			fs.writeFileSync(path.join(repo, 'a.txt'), 'AAA\n');
			const second = ensureReviewSurface(flowId, repo);
			expect(second?.refreshed).toBe(true);
			expect(second?.revision).toBe(2);
			expect(second?.fingerprint).not.toBe(first?.fingerprint);
			const secondHashes = surfaceHashes(fs.readFileSync(second!.path, 'utf8'));
			expect(secondHashes.get('a.txt')).not.toBe(firstHashes.get('a.txt'));
			expect(secondHashes.get('b.txt')).toBe(firstHashes.get('b.txt'));

			// The outgoing revision is retained so a later round can compare snapshots per file.
			const retained = path.join(reviewSurfaceHistoryDir(flowId), 'review-surface-r1.md');
			expect(fs.existsSync(retained)).toBe(true);
			expect(surfaceHashes(fs.readFileSync(retained, 'utf8')).get('a.txt')).toBe(
				firstHashes.get('a.txt'),
			);

			const unchanged = ensureReviewSurface(flowId, repo);
			expect(unchanged?.refreshed).toBe(false);
			expect(unchanged?.revision).toBe(2);
		},
		GIT_TEST_TIMEOUT_MS,
	);

	it(
		'records an unavailable hash for a deleted tracked path',
		() => {
			const agentDir = makeTempDir();
			stubEnv(agentDir);
			const repo = gitRepo();
			fs.writeFileSync(path.join(repo, 'tracked.txt'), 'tracked\n');
			commitAll(repo, 'add tracked');
			const flowId = 'flow-surface-deleted';
			expect(ensureReviewSurface(flowId, repo)?.dirtyPaths).toEqual([]);
			fs.rmSync(path.join(repo, 'tracked.txt'));
			const after = ensureReviewSurface(flowId, repo);
			expect(after?.refreshed).toBe(true);
			const afterContent = fs.readFileSync(after!.path, 'utf8');
			expect(afterContent).toContain('\n D tracked.txt');
			expect(surfaceHashes(afterContent).get('tracked.txt')).toBe('(unavailable)');
			// A deleted path is expected and content-independent, so it must not churn the revision.
			const reused = ensureReviewSurface(flowId, repo);
			expect(reused?.refreshed).toBe(false);
			expect(reused?.revision).toBe(2);
		},
		GIT_TEST_TIMEOUT_MS,
	);

	it(
		'refreshes when only the staging state changes',
		() => {
			const agentDir = makeTempDir();
			stubEnv(agentDir);
			const repo = gitRepo();
			fs.writeFileSync(path.join(repo, 'tracked.txt'), 'first\n');
			commitAll(repo, 'add tracked');
			fs.writeFileSync(path.join(repo, 'tracked.txt'), 'second\n');
			const flowId = 'flow-surface-staging';
			const unstaged = ensureReviewSurface(flowId, repo);
			expect(unstaged?.refreshed).toBe(true);
			const beforeHashes = surfaceHashes(fs.readFileSync(unstaged!.path, 'utf8'));
			gitIn(repo, ['add', 'tracked.txt']);
			const staged = ensureReviewSurface(flowId, repo);
			expect(staged?.refreshed).toBe(true);
			expect(staged?.revision).toBe(2);
			expect(surfaceHashes(fs.readFileSync(staged!.path, 'utf8')).get('tracked.txt')).toBe(
				beforeHashes.get('tracked.txt'),
			);
			// The hunk read compares against the head too, so staging a change does not empty that section.
			expect(fs.readFileSync(staged!.path, 'utf8')).toContain('@@ ');
		},
		GIT_TEST_TIMEOUT_MS,
	);

	it(
		'retains a bounded revision history and exposes it in read manifests',
		() => {
			const agentDir = makeTempDir();
			stubEnv(agentDir);
			const repo = gitRepo();
			fs.writeFileSync(path.join(repo, 'a.txt'), 'v0\n');
			const flowId = 'flow-surface-history';
			let surface = ensureReviewSurface(flowId, repo)!;
			const historyDir = reviewSurfaceHistoryDir(flowId);
			const beforeRefresh = buildReadManifest({
				delegationId: 'fresh-consumer',
				flowId,
				role: 'reviewer',
				evidenceScope: 'flow',
				reviewSurfacePath: surface.path,
			});
			expect(beforeRefresh.artifactPaths).not.toContain(historyDir);
			expect(beforeRefresh.establishedEvidence.some((line) => line.includes(historyDir))).toBe(
				false,
			);
			for (let index = 1; index <= 12; index += 1) {
				fs.writeFileSync(path.join(repo, 'a.txt'), `v${index}\n`);
				surface = ensureReviewSurface(flowId, repo)!;
			}
			expect(surface.revision).toBe(13);
			const retained = fs.readdirSync(historyDir).toSorted();
			expect(retained).toHaveLength(10);
			expect(retained).toContain('review-surface-r12.md');
			expect(retained).not.toContain('review-surface-r1.md');
			expect(retained).not.toContain('review-surface-r2.md');

			const manifest = buildReadManifest({
				delegationId: 'history-consumer',
				flowId,
				role: 'reviewer',
				evidenceScope: 'flow',
				reviewSurfacePath: surface.path,
			});
			expect(manifest.artifactPaths).toContain(surface.path);
			expect(manifest.artifactPaths).toContain(historyDir);
			expect(
				manifest.establishedEvidence.some((line) =>
					line.includes(`10 earlier review-surface revision(s) are retained under ${historyDir}`),
				),
			).toBe(true);
			const withoutSurface = buildReadManifest({
				delegationId: 'no-surface',
				flowId,
				role: 'reviewer',
				evidenceScope: 'flow',
			});
			expect(withoutSurface.artifactPaths).not.toContain(historyDir);
		},
		GIT_TEST_TIMEOUT_MS,
	);

	it(
		'hashes a tail window for paths above the hashing bound',
		() => {
			const agentDir = makeTempDir();
			stubEnv(agentDir);
			const repo = gitRepo();
			const large = path.join(repo, 'large.bin');
			fs.writeFileSync(large, `${'x'.repeat(9 * 1024 * 1024 - 1)}\n`);
			const flowId = 'flow-surface-large';
			const first = ensureReviewSurface(flowId, repo);
			expect(first?.refreshed).toBe(true);
			const firstContent = fs.readFileSync(first!.path, 'utf8');
			expect(firstContent).toContain('(partial)  large.bin');
			// Same size, changed last byte: only a tail window can see this edit.
			fs.writeFileSync(large, `${'x'.repeat(9 * 1024 * 1024 - 2)}y\n`);
			const second = ensureReviewSurface(flowId, repo);
			expect(second?.refreshed).toBe(true);
			expect(second?.revision).toBe(2);
			expect(surfaceHashes(fs.readFileSync(second!.path, 'utf8')).get('large.bin')).not.toBe(
				surfaceHashes(firstContent).get('large.bin'),
			);
		},
		GIT_TEST_TIMEOUT_MS,
	);

	it(
		'lists untracked directory contents individually so their changes refresh',
		() => {
			const agentDir = makeTempDir();
			stubEnv(agentDir);
			const repo = gitRepo();
			fs.mkdirSync(path.join(repo, 'dir'));
			fs.writeFileSync(path.join(repo, 'dir', 'a.txt'), 'a\n');
			const flowId = 'flow-surface-untracked-dir';
			const first = ensureReviewSurface(flowId, repo);
			expect(first?.dirtyPaths).toEqual(['dir/a.txt']);
			expect(surfaceHashes(fs.readFileSync(first!.path, 'utf8')).get('dir/a.txt')).toMatch(
				/^[0-9a-f]{64}$/,
			);
			fs.writeFileSync(path.join(repo, 'dir', 'b.txt'), 'b\n');
			const second = ensureReviewSurface(flowId, repo);
			expect(second?.refreshed).toBe(true);
			expect(second?.revision).toBe(2);
			expect(surfaceHashes(fs.readFileSync(second!.path, 'utf8')).get('dir/b.txt')).toMatch(
				/^[0-9a-f]{64}$/,
			);
		},
		GIT_TEST_TIMEOUT_MS,
	);

	it(
		'refreshes for a change past the dirty-path cap through the diff stat backstop',
		() => {
			const agentDir = makeTempDir();
			stubEnv(agentDir);
			const repo = gitRepo();
			const names = Array.from(
				{ length: 101 },
				(_, index) => `f${String(index).padStart(3, '0')}.txt`,
			);
			for (const name of names) fs.writeFileSync(path.join(repo, name), 'x\n');
			commitAll(repo, 'seed files');
			for (const name of names) fs.writeFileSync(path.join(repo, name), 'y\n');
			const flowId = 'flow-surface-cap';
			const first = ensureReviewSurface(flowId, repo);
			expect(first?.dirtyPaths).toHaveLength(100);
			expect(first?.dirtyPaths).not.toContain('f100.txt');
			// f100.txt is past the hash cap: only the diff stat sees its line-count change.
			fs.writeFileSync(path.join(repo, 'f100.txt'), 'y\nz\n');
			const second = ensureReviewSurface(flowId, repo);
			expect(second?.refreshed).toBe(true);
			expect(second?.revision).toBe(2);
			// The window leaves a dirty path out, so the fingerprint cannot prove the tree unchanged and a
			// same-size edit to any path outside it must still produce a new revision.
			const third = ensureReviewSurface(flowId, repo);
			expect(third?.refreshed).toBe(true);
			expect(third?.revision).toBe(3);
		},
		GIT_TEST_TIMEOUT_MS,
	);

	it(
		'keeps the snapshot when the retention directory is unusable',
		() => {
			const agentDir = makeTempDir();
			stubEnv(agentDir);
			const repo = gitRepo();
			fs.writeFileSync(path.join(repo, 'a.txt'), 'v0\n');
			const flowId = 'flow-surface-retention-failure';
			ensureReviewSurface(flowId, repo);
			fs.writeFileSync(path.join(repo, 'a.txt'), 'v1\n');
			const historyDir = reviewSurfaceHistoryDir(flowId);
			fs.mkdirSync(path.dirname(historyDir), { recursive: true });
			fs.writeFileSync(historyDir, 'not a directory');
			const refreshed = ensureReviewSurface(flowId, repo);
			expect(refreshed?.refreshed).toBe(true);
			expect(refreshed?.revision).toBe(2);
			const reused = ensureReviewSurface(flowId, repo);
			expect(reused?.refreshed).toBe(false);
			expect(reused?.revision).toBe(2);
		},
		GIT_TEST_TIMEOUT_MS,
	);

	it(
		'never reuses a fingerprint built from failed git reads',
		() => {
			const agentDir = makeTempDir();
			stubEnv(agentDir);
			const dir = makeTempDir();
			const flowId = 'flow-surface-tainted';
			const first = ensureReviewSurface(flowId, dir);
			expect(first?.refreshed).toBe(true);
			expect(first?.revision).toBe(1);
			expect(fs.readFileSync(first!.path, 'utf8')).toContain('(unavailable)');
			fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
			const second = ensureReviewSurface(flowId, dir);
			expect(second?.refreshed).toBe(true);
			expect(second?.revision).toBe(2);
		},
		GIT_TEST_TIMEOUT_MS,
	);

	it(
		'keeps delta evidence ahead of the status text and caps the hashed paths',
		() => {
			const agentDir = makeTempDir();
			stubEnv(agentDir);
			const repo = gitRepo();
			for (let index = 0; index < 150; index += 1)
				fs.writeFileSync(path.join(repo, `file-${String(index).padStart(3, '0')}.txt`), 'x\n');
			const flowId = 'flow-surface-order';
			const surface = ensureReviewSurface(flowId, repo);
			const content = fs.readFileSync(surface!.path, 'utf8');
			expect(content.indexOf('## File hashes')).toBeLessThan(
				content.indexOf('## Working-tree status'),
			);
			expect(content).toContain('file-149.txt');
			expect(surfaceHashes(content).size).toBe(100);
			expect(surface?.dirtyPaths).toHaveLength(100);
		},
		GIT_TEST_TIMEOUT_MS,
	);

	it(
		'hashes a path that git would C-quote in line mode',
		() => {
			const agentDir = makeTempDir();
			stubEnv(agentDir);
			const repo = gitRepo();
			const name = 'π.txt';
			fs.writeFileSync(path.join(repo, name), 'ab\n');
			const flowId = 'flow-surface-quoted-path';
			const first = ensureReviewSurface(flowId, repo);
			const firstContent = fs.readFileSync(first!.path, 'utf8');
			expect(firstContent).toContain(`?? ${name}`);
			expect(firstContent).not.toContain('\\317');
			const firstHash = surfaceHashes(firstContent).get(name);
			expect(firstHash).toMatch(/^[0-9a-f]{64}$/);

			// Same byte length, same stat, same head: only the content hash can see this edit.
			fs.writeFileSync(path.join(repo, name), 'ba\n');
			const second = ensureReviewSurface(flowId, repo);
			expect(second?.refreshed).toBe(true);
			expect(second?.revision).toBe(2);
			expect(surfaceHashes(fs.readFileSync(second!.path, 'utf8')).get(name)).not.toBe(firstHash);
			const reused = ensureReviewSurface(flowId, repo);
			expect(reused?.refreshed).toBe(false);
			expect(reused?.revision).toBe(2);
		},
		GIT_TEST_TIMEOUT_MS,
	);

	it(
		'fingerprints a dirty symlink by its target string',
		() => {
			const agentDir = makeTempDir();
			stubEnv(agentDir);
			const repo = gitRepo();
			fs.writeFileSync(path.join(repo, 'left.txt'), 'same\n');
			fs.writeFileSync(path.join(repo, 'right.txt'), 'same\n');
			commitAll(repo, 'targets');
			fs.symlinkSync('left.txt', path.join(repo, 'link'));
			const flowId = 'flow-surface-symlink';
			const first = ensureReviewSurface(flowId, repo);
			const firstHash = surfaceHashes(fs.readFileSync(first!.path, 'utf8')).get('link');
			expect(firstHash).toMatch(/^[0-9a-f]{64}$/);

			// Repointing the link to a target with identical bytes keeps the status text, the stat, and the
			// dereferenced bytes identical, so only the link's own target string can refresh the revision.
			fs.unlinkSync(path.join(repo, 'link'));
			fs.symlinkSync('right.txt', path.join(repo, 'link'));
			const second = ensureReviewSurface(flowId, repo);
			expect(second?.refreshed).toBe(true);
			expect(second?.revision).toBe(2);
			expect(surfaceHashes(fs.readFileSync(second!.path, 'utf8')).get('link')).not.toBe(firstHash);
			const reused = ensureReviewSurface(flowId, repo);
			expect(reused?.refreshed).toBe(false);
			expect(reused?.revision).toBe(2);
		},
		GIT_TEST_TIMEOUT_MS,
	);

	it(
		'splits a staged rename into a hashable delete and add',
		() => {
			const agentDir = makeTempDir();
			stubEnv(agentDir);
			const repo = gitRepo();
			fs.writeFileSync(path.join(repo, 'tracked.txt'), 'tracked\n');
			commitAll(repo, 'add tracked');
			gitIn(repo, ['mv', 'tracked.txt', 'renamed.txt']);
			const flowId = 'flow-surface-rename';
			const surface = ensureReviewSurface(flowId, repo);
			expect(surface?.dirtyPaths.toSorted()).toEqual(['renamed.txt', 'tracked.txt']);
			const content = fs.readFileSync(surface!.path, 'utf8');
			expect(content).not.toContain(' -> ');
			const hashes = surfaceHashes(content);
			expect(hashes.get('renamed.txt')).toMatch(/^[0-9a-f]{64}$/);
			expect(hashes.get('tracked.txt')).toBe('(unavailable)');
		},
		GIT_TEST_TIMEOUT_MS,
	);

	it.skipIf(process.getuid?.() === 0)(
		'forces a new revision when an existing path cannot be read',
		() => {
			const agentDir = makeTempDir();
			stubEnv(agentDir);
			const repo = gitRepo();
			const locked = path.join(repo, 'locked.txt');
			fs.writeFileSync(locked, 'secret\n');
			fs.chmodSync(locked, 0o000);
			const flowId = 'flow-surface-unreadable';
			const first = ensureReviewSurface(flowId, repo);
			expect(surfaceHashes(fs.readFileSync(first!.path, 'utf8')).get('locked.txt')).toBe(
				'(unavailable)',
			);
			// The same unreadable path would repeat the same gap, so reuse cannot claim freshness.
			const second = ensureReviewSurface(flowId, repo);
			expect(second?.refreshed).toBe(true);
			expect(second?.revision).toBe(2);
		},
		GIT_TEST_TIMEOUT_MS,
	);

	it(
		'parses the status when the repository forces colored output',
		() => {
			const agentDir = makeTempDir();
			stubEnv(agentDir);
			const repo = gitRepo();
			gitIn(repo, ['config', 'color.status', 'always']);
			gitIn(repo, ['config', 'color.ui', 'always']);
			fs.writeFileSync(path.join(repo, 'colored.txt'), 'x\n');
			const flowId = 'flow-surface-color';
			const surface = ensureReviewSurface(flowId, repo);
			expect(surface?.dirtyPaths).toEqual(['colored.txt']);
			expect(surfaceHashes(fs.readFileSync(surface!.path, 'utf8')).get('colored.txt')).toMatch(
				/^[0-9a-f]{64}$/,
			);
		},
		GIT_TEST_TIMEOUT_MS,
	);

	it(
		'fails closed for a path whose bytes cannot round-trip through the status read',
		(context) => {
			const agentDir = makeTempDir();
			stubEnv(agentDir);
			const repo = gitRepo();
			try {
				fs.writeFileSync(
					Buffer.concat([
						Buffer.from(`${repo}/`),
						Buffer.from([0x62, 0xff, 0x2e, 0x74, 0x78, 0x74]),
					]),
					'x\n',
				);
			} catch {
				// Filesystems such as APFS reject non-UTF-8 names outright; report the case as skipped rather than
				// passing it silently, and keep it exercised where such names exist.
				context.skip();
				return;
			}
			const flowId = 'flow-surface-raw-bytes';
			const first = ensureReviewSurface(flowId, repo);
			expect(fs.readFileSync(first!.path, 'utf8')).toContain('(unavailable)');
			// The decoded status cannot address that path, so a repeated read cannot prove freshness.
			const second = ensureReviewSurface(flowId, repo);
			expect(second?.refreshed).toBe(true);
			expect(second?.revision).toBe(2);
		},
		GIT_TEST_TIMEOUT_MS,
	);

	it(
		'taints the fingerprint for a dirty path too long to bound',
		() => {
			const agentDir = makeTempDir();
			stubEnv(agentDir);
			const repo = gitRepo();
			const nested = path.join(repo, 'd'.repeat(200), 'e'.repeat(200));
			fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(path.join(nested, `${'f'.repeat(200)}.txt`), 'x\n');
			const flowId = 'flow-surface-overlong';
			const first = ensureReviewSurface(flowId, repo);
			expect(first?.dirtyPaths).toEqual([]);
			const second = ensureReviewSurface(flowId, repo);
			expect(second?.refreshed).toBe(true);
			expect(second?.revision).toBe(2);
		},
		GIT_TEST_TIMEOUT_MS,
	);

	it(
		'refreshes when only the mode of an already dirty file changes',
		() => {
			const agentDir = makeTempDir();
			stubEnv(agentDir);
			const repo = gitRepo();
			const target = path.join(repo, 'script.sh');
			fs.writeFileSync(target, 'one\n');
			commitAll(repo, 'add script');
			fs.writeFileSync(target, 'two\n');
			const flowId = 'flow-surface-mode';
			const first = ensureReviewSurface(flowId, repo);
			expect(first?.refreshed).toBe(true);
			expect(first?.revision).toBe(1);
			const content = fs.readFileSync(first!.path, 'utf8');
			expect(content).toMatch(/^worktree_delta: [0-9a-f]{64}$/m);
			// The bytes, the status codes, and the diff stat all stay the same, so only the worktree delta
			// covers the permission change.
			fs.chmodSync(target, 0o755);
			const second = ensureReviewSurface(flowId, repo);
			expect(second?.refreshed).toBe(true);
			expect(second?.revision).toBe(2);
			const unchanged = ensureReviewSurface(flowId, repo);
			expect(unchanged?.refreshed).toBe(false);
			expect(unchanged?.revision).toBe(2);
		},
		GIT_TEST_TIMEOUT_MS,
	);

	it(
		'refreshes when only the mode of an untracked file changes',
		() => {
			const agentDir = makeTempDir();
			stubEnv(agentDir);
			const repo = gitRepo();
			const target = path.join(repo, 'tool.sh');
			fs.writeFileSync(target, 'echo hi\n');
			const flowId = 'flow-surface-untracked-mode';
			const first = ensureReviewSurface(flowId, repo);
			expect(first?.refreshed).toBe(true);
			// Git does not model the executable bit of an untracked file, so only the per-file hash can
			// report the change.
			fs.chmodSync(target, 0o755);
			const second = ensureReviewSurface(flowId, repo);
			expect(second?.refreshed).toBe(true);
			expect(second?.revision).toBe(2);
			const unchanged = ensureReviewSurface(flowId, repo);
			expect(unchanged?.refreshed).toBe(false);
			expect(unchanged?.revision).toBe(2);
		},
		GIT_TEST_TIMEOUT_MS,
	);

	it(
		'fails closed for a dirty path whose name cannot round-trip through a string',
		() => {
			const agentDir = makeTempDir();
			stubEnv(agentDir);
			const repo = gitRepo();
			const name = '\uFFFD.txt';
			fs.writeFileSync(path.join(repo, name), 'x\n');
			const flowId = 'flow-surface-replacement';
			const first = ensureReviewSurface(flowId, repo);
			expect(first?.refreshed).toBe(true);
			// The decoded name may address a different file than git reported, so the path is refused instead
			// of hashing bytes that may not be that path's, and the refusal taints the fingerprint.
			const content = fs.readFileSync(first!.path, 'utf8');
			expect(content).toContain(`(unavailable)  ${name}`);
			const second = ensureReviewSurface(flowId, repo);
			expect(second?.refreshed).toBe(true);
			expect(second?.revision).toBe(2);
		},
		GIT_TEST_TIMEOUT_MS,
	);

	it(
		'taints the fingerprint when the worktree delta exceeds the read bound',
		() => {
			const agentDir = makeTempDir();
			stubEnv(agentDir);
			const repo = gitRepo();
			const target = path.join(repo, 'big.txt');
			// Every line is unique, so the diff cannot share context and has to carry both full bodies.
			fs.writeFileSync(target, bigFileBody('one'));
			commitAll(repo, 'add big file');
			fs.writeFileSync(target, bigFileBody('two'));
			const flowId = 'flow-surface-delta-bound';
			const first = ensureReviewSurface(flowId, repo);
			expect(first?.refreshed).toBe(true);
			const content = fs.readFileSync(first!.path, 'utf8');
			expect(content).toContain('worktree_delta: (unavailable)');
			// A delta the read bound cannot hold in full cannot prove the tree unchanged, so the fingerprint is
			// tainted instead of being reused as if the unseen part had not changed.
			const second = ensureReviewSurface(flowId, repo);
			expect(second?.refreshed).toBe(true);
			expect(second?.revision).toBe(2);
		},
		GIT_TEST_TIMEOUT_MS,
	);

	it(
		'hashes repository-root relative paths for a subdirectory delegation directory',
		() => {
			const agentDir = makeTempDir();
			stubEnv(agentDir);
			const repo = gitRepo();
			const sub = path.join(repo, 'sub');
			fs.mkdirSync(sub);
			fs.writeFileSync(path.join(sub, 'nested.txt'), 'nested\n');
			gitIn(repo, ['config', 'status.relativePaths', 'false']);
			const flowId = 'flow-surface-subdir';
			const surface = ensureReviewSurface(flowId, sub);
			expect(surface?.dirtyPaths).toEqual(['sub/nested.txt']);
			const content = fs.readFileSync(surface!.path, 'utf8');
			expect(content).toContain(`git_root: ${repo}`);
			// The snapshot belongs to the flow rather than to one delegation, so it records repository facts
			// only: a delegation rooted elsewhere reuses it instead of reading a header field that names
			// another delegation's directory.
			expect(content).not.toMatch(/^cwd:/m);
			expect(surfaceHashes(content).get('sub/nested.txt')).toMatch(/^[0-9a-f]{64}$/);
			const reused = ensureReviewSurface(flowId, sub);
			expect(reused?.refreshed).toBe(false);
			expect(reused?.revision).toBe(1);
			const reusedFromRoot = ensureReviewSurface(flowId, repo);
			expect(reusedFromRoot?.refreshed).toBe(false);
			expect(reusedFromRoot?.revision).toBe(1);
		},
		GIT_TEST_TIMEOUT_MS,
	);

	it(
		'taints the fingerprint when the hunk-header read fails instead of reporting no hunks',
		() => {
			const agentDir = makeTempDir();
			stubEnv(agentDir);
			const repo = gitRepo();
			fs.writeFileSync(path.join(repo, 'tracked.txt'), 'first\n');
			commitAll(repo, 'add tracked');
			fs.writeFileSync(path.join(repo, 'tracked.txt'), 'second\n');
			const flowId = 'flow-surface-hunk-read';
			const originalPath = process.env.PATH ?? '';
			try {
				// Only the hunk-header read fails while the other reads of the same delta succeed: that is the case
				// that used to render as a tree without hunks and then be reused as unchanged forever.
				process.env.PATH = `${fakeGitBin(makeTempDir())}${path.delimiter}${originalPath}`;
				const failed = ensureReviewSurface(flowId, repo);
				expect(failed?.refreshed).toBe(true);
				const content = fs.readFileSync(failed!.path, 'utf8');
				expect(content).toContain('worktree_hunks: (unavailable)');
				expect(content).toContain('## Diff hunk headers\n\n(unavailable)');
				// A failed read cannot prove the tree unchanged, so the degraded revision is never reused.
				expect(ensureReviewSurface(flowId, repo)?.revision).toBe(2);
			} finally {
				process.env.PATH = originalPath;
			}
			// Once the read works again the section carries real hunks instead of staying unavailable.
			const recovered = ensureReviewSurface(flowId, repo);
			expect(recovered?.refreshed).toBe(true);
			expect(fs.readFileSync(recovered!.path, 'utf8')).toContain('@@ ');
		},
		GIT_TEST_TIMEOUT_MS,
	);

	it(
		'refreshes when only the head moves',
		() => {
			const agentDir = makeTempDir();
			stubEnv(agentDir);
			const repo = gitRepo();
			fs.writeFileSync(path.join(repo, 'tracked.txt'), 'tracked\n');
			commitAll(repo, 'add tracked');
			const flowId = 'flow-surface-head-only';
			const first = ensureReviewSurface(flowId, repo);
			expect(first?.refreshed).toBe(true);
			// An empty commit leaves the status, the stat, both delta reads, and the hashes untouched.
			commitAll(repo, 'empty', true);
			const second = ensureReviewSurface(flowId, repo);
			expect(second?.head).not.toBe(first?.head);
			expect(second?.refreshed).toBe(true);
			expect(second?.revision).toBe(2);
		},
		GIT_TEST_TIMEOUT_MS,
	);

	it(
		'taints a dirty path that is not a regular file instead of opening it',
		(context) => {
			const agentDir = makeTempDir();
			stubEnv(agentDir);
			const repo = gitRepo();
			const swapped = path.join(repo, 'swapped.txt');
			fs.writeFileSync(swapped, 'tracked\n');
			commitAll(repo, 'add tracked');
			// git reports a tracked file replaced by a FIFO as modified, and reading that path would block until
			// a writer appeared, so it is refused instead of opened.
			fs.rmSync(swapped);
			if (spawnSync('mkfifo', [swapped], { encoding: 'utf8' }).status !== 0) {
				context.skip();
				return;
			}
			const flowId = 'flow-surface-special-file';
			const first = ensureReviewSurface(flowId, repo);
			expect(first?.dirtyPaths).toEqual(['swapped.txt']);
			expect(fs.readFileSync(first!.path, 'utf8')).toContain('(unavailable)  swapped.txt');
			// The path exists but has no readable content, so the fingerprint is tainted rather than reused.
			const second = ensureReviewSurface(flowId, repo);
			expect(second?.refreshed).toBe(true);
			expect(second?.revision).toBe(2);
		},
		GIT_TEST_TIMEOUT_MS,
	);
});
