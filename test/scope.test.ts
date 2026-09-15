import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flowDirFor, flowReportsDir } from '../src/flow.ts';
import { ensureReviewSurface } from '../src/scope.ts';
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
				{ ref: 'rr_published', reused: false, publication: 'published' },
				// Unpublished or failed-publication reads cannot resolve from a sibling lookup.
				{ ref: 'rr_unpublished', reused: false },
				{ ref: 'rr_failed', reused: false, publication: 'failed', publicationReason: 'denied' },
				{ ref: 'rr_conflict', reused: true, publication: 'published', flowIdConflict: true },
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
