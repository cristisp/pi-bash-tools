import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { getConfig } from './config.ts';
import type { Registry } from './types.ts';

export const REGISTRY_PATH = path.join(getAgentDir(), 'subagent-herdr.json');

export function sanitizeSegment(input: string): string {
	return path
		.basename(input)
		.replace(/[^\w.-]+/g, '_')
		.replace(/^\.+/, '');
}

export function readRegistry(): Registry {
	try {
		const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
		const parsed = JSON.parse(raw);
		if (
			parsed &&
			typeof parsed === 'object' &&
			typeof parsed.tabs === 'object' &&
			typeof parsed.counters === 'object'
		) {
			return parsed as Registry;
		}
	} catch {}
	return { counters: {}, tabs: {} };
}

function writeRegistry(reg: Registry): void {
	const tmp = `${REGISTRY_PATH}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 });
		fs.renameSync(tmp, REGISTRY_PATH);
	} catch {}
}

// fallow-ignore-next-line complexity
function withRegistryFileLock<T>(fn: () => T): T {
	const cfg = getConfig();
	const lockPath = `${REGISTRY_PATH}.lock`;
	const deadline = Date.now() + cfg.registryLockTimeoutMs;
	while (true) {
		try {
			const fd = fs.openSync(lockPath, 'wx');
			fs.closeSync(fd);
			try {
				return fn();
			} finally {
				try {
					fs.unlinkSync(lockPath);
				} catch {}
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
			try {
				if (Date.now() - fs.statSync(lockPath).mtimeMs > cfg.registryLockStaleMs) {
					fs.unlinkSync(lockPath);
					continue;
				}
			} catch {}
			if (Date.now() > deadline) {
				throw new Error('subagent-herdr registry lock timeout', { cause: err });
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
		}
	}
}

export function mutateRegistry(mutate: (reg: Registry) => void): void {
	withRegistryFileLock(() => {
		const reg = readRegistry();
		mutate(reg);
		writeRegistry(reg);
	});
}
