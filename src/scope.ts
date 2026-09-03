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

function snapshotText(flowId: string, cwd: string): string {
	const status = gitOutput(cwd, ['status', '--short']).trim() || '(clean)';
	const stat = gitOutput(cwd, ['diff', '--stat']).trim() || '(none)';
	const diff = gitOutput(cwd, ['diff', '--no-color', '--unified=0']);
	return capUtf8(
		[
			'# Review surface snapshot',
			'',
			`flow_id: ${flowId}`,
			`cwd: ${cwd}`,
			'',
			'## Working-tree status',
			'',
			status,
			'',
			'## Diff stat',
			'',
			stat,
			'',
			'## Diff hunk headers',
			'',
			hunkHeaders(diff),
			'',
		].join('\n'),
		MAX_SNAPSHOT_BYTES,
	);
}

export function reviewSurfacePath(flowId: string): string {
	return path.join(flowDirFor(flowId), PREDIGEST_SUBDIR, 'review-surface.md');
}

export function ensureReviewSurface(flowId: string | undefined, cwd: string): string | undefined {
	if (!flowId || !ensureFlow({ flowId })) return undefined;
	const target = reviewSurfacePath(flowId);
	try {
		return withFileLock(path.join(flowDirFor(flowId), '.lock'), () => {
			if (!fs.existsSync(target)) {
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, snapshotText(flowId, cwd), { encoding: 'utf8', mode: 0o600 });
			}
			return target;
		});
	} catch {
		return undefined;
	}
}
