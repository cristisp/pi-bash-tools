import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve(process.cwd(), 'analysis/collect-s5-telemetry.ts');
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), 'collect-s5-telemetry-test-'));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe('collect-s5-telemetry CLI', () => {
	it('does not create a missing stream in analyze mode', () => {
		const directory = temporaryDirectory();
		const stream = join(directory, 'missing.jsonl');
		const result = spawnSync(
			process.execPath,
			[script, 'analyze', '--stream', stream, '--agent-dir', join(directory, 'agent')],
			{ encoding: 'utf8' },
		);

		expect(result.status).toBe(1);
		expect(existsSync(stream)).toBe(false);
		expect(`${result.stdout}${result.stderr}`).toContain('Producer stream not found');
	});

	it('rejects reset in analyze mode without changing an existing stream', () => {
		const directory = temporaryDirectory();
		const stream = join(directory, 'existing.jsonl');
		const original = '{"existing":true}\n{"another":"record"}\n';
		writeFileSync(stream, original);
		const result = spawnSync(
			process.execPath,
			[script, 'analyze', '--reset', '--stream', stream, '--agent-dir', join(directory, 'agent')],
			{ encoding: 'utf8' },
		);

		expect(result.status).toBe(2);
		expect(readFileSync(stream, 'utf8')).toBe(original);
	});

	it('resets an existing stream in prepare mode', () => {
		const directory = temporaryDirectory();
		const stream = join(directory, 'existing.jsonl');
		writeFileSync(stream, '{"existing":true}\n');
		const result = spawnSync(process.execPath, [script, 'prepare', '--reset', '--stream', stream], {
			encoding: 'utf8',
		});

		expect(result.status).toBe(0);
		expect(existsSync(stream)).toBe(true);
		expect(readFileSync(stream, 'utf8')).toBe('');
	});

	it('resolves relative paths from the invocation directory', () => {
		const directory = temporaryDirectory();
		const result = spawnSync(
			process.execPath,
			[script, 'prepare', '--stream', 'stream.jsonl', '--agent-dir', 'agent'],
			{ cwd: directory, encoding: 'utf8' },
		);

		expect(result.status).toBe(0);
		expect(existsSync(join(directory, 'stream.jsonl'))).toBe(true);
		expect(result.stdout).toContain(join(directory, 'stream.jsonl'));
	});

	it('rejects missing option values instead of consuming another option', () => {
		const directory = temporaryDirectory();
		const result = spawnSync(
			process.execPath,
			[script, 'prepare', '--stream', '--agent-dir', join(directory, 'agent')],
			{ encoding: 'utf8' },
		);

		expect(result.status).toBe(2);
		expect(`${result.stdout}${result.stderr}`).toContain('--stream requires a path value');
	});
});
