import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { flowDirFor, ensureFlow, PREDIGEST_SUBDIR } from './flow.ts';
import { withFileLock } from './registry-store.ts';

const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

function capUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
	const suffix = '\n[review surface snapshot truncated]\n';
	const suffixBytes = Buffer.byteLength(suffix, 'utf8');
	const prefix = Buffer.from(value, 'utf8')
		.subarray(0, Math.max(0, maxBytes - suffixBytes))
		.toString('utf8');
	return `${prefix}${suffix}`;
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
		return '(unavailable)';
	}
}

function hunkHeaders(diff: string): string {
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
	dirtyPaths: string[];
}

interface SnapshotInputs {
	status: string;
	stat: string;
	diff: string;
	fingerprint: string;
	dirtyPaths: string[];
}

function dirtyPathsFromStatus(status: string): string[] {
	if (status === '(clean)' || status === '(unavailable)') return [];
	return status
		.split('\n')
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.map((line) => {
			const value = line.length > 3 ? line.slice(3).trim() : line.trim();
			const rename = value.lastIndexOf(' -> ');
			return rename >= 0 ? value.slice(rename + 4) : value;
		})
		.filter(
			(value, index, all) =>
				value.length > 0 && value.length <= MAX_DIRTY_PATH_LENGTH && all.indexOf(value) === index,
		)
		.slice(0, MAX_DIRTY_PATHS);
}

function snapshotInputs(cwd: string): SnapshotInputs {
	const status = gitOutput(cwd, ['status', '--short']).trim() || '(clean)';
	const stat = gitOutput(cwd, ['diff', '--stat']).trim() || '(none)';
	const diff = gitOutput(cwd, ['diff', '--no-color', '--unified=0']);
	const fingerprint = createHash('sha256').update(`${status}\n${stat}`).digest('hex');
	return { status, stat, diff, fingerprint, dirtyPaths: dirtyPathsFromStatus(status) };
}

function snapshotText(
	flowId: string,
	cwd: string,
	inputs: SnapshotInputs,
	revision: number,
): string {
	return capUtf8(
		[
			'# Review surface snapshot',
			'',
			`flow_id: ${flowId}`,
			`snapshot_fingerprint: ${inputs.fingerprint}`,
			`snapshot_revision: ${revision}`,
			`cwd: ${cwd}`,
			'',
			'## Working-tree status',
			'',
			inputs.status,
			'',
			'## Diff stat',
			'',
			inputs.stat,
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
	return path.join(flowDirFor(flowId), PREDIGEST_SUBDIR, 'review-surface.md');
}

export function ensureReviewSurface(
	flowId: string | undefined,
	cwd: string,
): ReviewSurfaceSnapshot | undefined {
	if (!flowId || !ensureFlow({ flowId })) return undefined;
	const target = reviewSurfacePath(flowId);
	try {
		return withFileLock(path.join(flowDirFor(flowId), '.lock'), () => {
			const inputs = snapshotInputs(cwd);
			const previous = snapshotMetadata(target);
			if (previous?.fingerprint === inputs.fingerprint) {
				return {
					path: target,
					revision: previous.revision,
					refreshed: false,
					dirtyPaths: inputs.dirtyPaths,
				};
			}
			const revision = previous ? previous.revision + 1 : 1;
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, snapshotText(flowId, cwd, inputs, revision), {
				encoding: 'utf8',
				mode: 0o600,
			});
			return { path: target, revision, refreshed: true, dirtyPaths: inputs.dirtyPaths };
		});
	} catch {
		return undefined;
	}
}
