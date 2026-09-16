import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { outsideRootCwds } from '../src/spawn-boundary.ts';

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeRoot(): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-boundary-')));
	dirs.push(dir);
	return dir;
}

describe('outsideRootCwds', () => {
	it('allows the root itself, subfolders, and missing cwd entries', () => {
		const root = makeRoot();
		expect(outsideRootCwds(root, [undefined, root, path.join(root, 'sub', 'deep')])).toEqual([]);
	});

	it('refuses siblings, parents, and traversal escapes', () => {
		const root = makeRoot();
		const offenders = outsideRootCwds(root, [
			path.join(path.dirname(root), 'sibling'),
			path.dirname(root),
			path.join(root, '..', 'elsewhere'),
		]);
		expect(offenders).toHaveLength(3);
	});

	it('allows a relative subfolder under the root and refuses a relative escape regardless of process cwd', () => {
		const root = makeRoot();
		const offenders = outsideRootCwds(root, ['sub', '../outside']);
		expect(offenders.map((o) => o.raw)).toEqual(['../outside']);
	});

	it('reports raw and resolved paths', () => {
		const root = makeRoot();
		const escape = path.join(root, '..', 'elsewhere');
		const offenders = outsideRootCwds(root, [escape]);
		expect(offenders).toHaveLength(1);
		expect(offenders[0].raw).toBe(escape);
		expect(path.isAbsolute(offenders[0].resolved)).toBe(true);
	});

	it('allows a missing subfolder under the root and refuses a missing path outside it', () => {
		const root = makeRoot();
		const offenders = outsideRootCwds(root, [
			path.join(root, 'missing', 'sub'),
			path.join(os.tmpdir(), 'spawn-boundary-not-here'),
		]);
		expect(offenders.map((o) => o.raw)).toEqual([
			path.join(os.tmpdir(), 'spawn-boundary-not-here'),
		]);
	});

	it('refuses a symlink inside the root pointing outside it', () => {
		const root = makeRoot();
		const outside = makeRoot();
		fs.symlinkSync(outside, path.join(root, 'link'), 'dir');
		const offenders = outsideRootCwds(root, [
			path.join(root, 'link'),
			path.join(root, 'link', 'sub'),
		]);
		expect(offenders.map((o) => o.raw)).toEqual([
			path.join(root, 'link'),
			path.join(root, 'link', 'sub'),
		]);
	});

	it('allows a symlink inside the root pointing back inside it', () => {
		const root = makeRoot();
		fs.mkdirSync(path.join(root, 'real'));
		fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'), 'dir');
		expect(outsideRootCwds(root, [path.join(root, 'link', 'sub')])).toEqual([]);
	});

	it('treats the filesystem root as a boundary that contains every absolute path', () => {
		const offenders = outsideRootCwds('/', ['/etc', '/usr/local']);
		expect(offenders).toEqual([]);
	});

	it('deduplicates repeated offenders', () => {
		const root = makeRoot();
		const sibling = path.join(path.dirname(root), 'sibling');
		const offenders = outsideRootCwds(root, [sibling, sibling, path.join(sibling, 'child')]);
		expect(offenders).toHaveLength(2);
		expect(offenders.map((o) => o.raw)).toEqual([sibling, path.join(sibling, 'child')]);
	});
});
