import * as fs from 'node:fs';
import * as path from 'node:path';

export interface OutsideRootCwd {
	raw: string;
	resolved: string;
}

/**
 * Canonicalizes a path for the spawn boundary comparison. Relative values resolve against the
 * root session folder; the herdr CLI inherits that same process cwd (execFile without a cwd
 * option), so relative values validated here resolve to the same folder at spawn time.
 * Existing paths resolve through realpath so symlinked roots still compare; missing paths
 * canonicalize the deepest existing ancestor and re-attach the unresolved remainder.
 */
function canonicalize(target: string, rootCwd: string): string {
	const resolved = path.resolve(rootCwd, target);
	try {
		return fs.realpathSync(resolved);
	} catch {}
	const parts: string[] = [];
	let current = resolved;
	while (true) {
		const parent = path.dirname(current);
		if (parent === current) return resolved;
		parts.unshift(path.basename(current));
		try {
			return path.join(fs.realpathSync(parent), ...parts);
		} catch {
			current = parent;
		}
	}
}

function isInsideRoot(root: string, target: string): boolean {
	if (target === root) return true;
	if (root === path.parse(root).root) return target.startsWith(root);
	return target.startsWith(root + path.sep);
}

/**
 * Subagents may only be spawned inside the root session folder. Returns the requested cwd
 * values that resolve outside it; empty means every request is inside the boundary.
 */
export function outsideRootCwds(
	rootCwd: string,
	cwds: readonly (string | undefined)[],
): OutsideRootCwd[] {
	const root = canonicalize(rootCwd, rootCwd);
	const offenders: OutsideRootCwd[] = [];
	const seen = new Set<string>();
	for (const cwd of cwds) {
		if (!cwd) continue;
		const resolved = canonicalize(cwd, rootCwd);
		if (isInsideRoot(root, resolved) || seen.has(resolved)) continue;
		seen.add(resolved);
		offenders.push({ raw: cwd, resolved });
	}
	return offenders;
}
