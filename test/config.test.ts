import * as fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configPath, DEFAULT_CONFIG, getConfig, parseModelPresets } from '../src/config.ts';
import { makeTempDir, stubEnv } from './helpers.ts';

function writeConfigFile(partial: Record<string, unknown>): void {
	fs.writeFileSync(configPath(), JSON.stringify(partial));
}

describe('getConfig - defaults', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('returns defaults when no config file exists', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		expect(getConfig()).toEqual(DEFAULT_CONFIG);
	});

	it('returns defaults when the config file is invalid JSON', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		writeConfigFile('{ not json' as never);
		expect(getConfig()).toEqual(DEFAULT_CONFIG);
	});
});

describe('getConfig - overrides', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('applies valid overrides from the config file', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		const overrides = {
			maxParallelTasks: 3,
			maxConcurrency: 2,
			pollIntervalMs: 250,
			startupTimeoutMs: 5000,
			settleStabilityMs: 1000,
			statusLossTimeoutMs: 30_000,
			abortGraceMs: 30_000,
			steerTimeoutMs: 30_000,
			perTaskOutputCap: 1024,
			registryLockTimeoutMs: 2000,
			registryLockStaleMs: 1000,
			herdrCliTimeoutMs: 4000,
			defaultAgentScope: 'both',
			confirmProjectAgents: false,
			modelPresets: { fast: { worker: 'p/m:high' } },
			defaultPreset: 'fast',
		};
		writeConfigFile(overrides);
		expect(getConfig()).toEqual(overrides);
	});
});

describe('getConfig - model presets', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('normalizes model specs and keeps valid preset entries', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		writeConfigFile({
			modelPresets: {
				cheap: { worker: 'P/M:HIGH', scout: 'p/n' },
			},
			defaultPreset: 'cheap',
		});
		const cfg = getConfig();
		expect(cfg.modelPresets).toEqual({ cheap: { worker: 'P/M:high', scout: 'p/n' } });
		expect(cfg.defaultPreset).toBe('cheap');
	});

	it('drops invalid preset entries and empty presets, ignoring an unknown defaultPreset', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		writeConfigFile({
			modelPresets: {
				broken: { worker: 'no-slash', scout: 42 },
				empty: { planner: 'also-bad' },
				good: { worker: 'p/m:low' },
				notAnObject: 'nope',
				array: ['p/m'],
			},
			defaultPreset: 'missing',
		});
		const cfg = getConfig();
		expect(cfg.modelPresets).toEqual({ good: { worker: 'p/m:low' } });
		expect(cfg.defaultPreset).toBeUndefined();
	});

	it('defaults to empty presets when modelPresets is missing or malformed', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		writeConfigFile({ modelPresets: 'nope', defaultPreset: 42 });
		const cfg = getConfig();
		expect(cfg.modelPresets).toEqual({});
		expect(cfg.defaultPreset).toBeUndefined();
	});

	it('ignores inherited names that are not real presets and drops __proto__ keys', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		writeConfigFile({ modelPresets: {}, defaultPreset: 'constructor' });
		let cfg = getConfig();
		expect(cfg.modelPresets).toEqual({});
		expect(cfg.defaultPreset).toBeUndefined();

		fs.writeFileSync(
			configPath(),
			'{"modelPresets":{"__proto__":{"worker":"p/m:high"}},"defaultPreset":"__proto__"}',
		);
		cfg = getConfig();
		expect(cfg.modelPresets).toEqual({});
		expect(cfg.defaultPreset).toBeUndefined();
		expect(Object.getPrototypeOf(cfg.modelPresets)).toBe(Object.prototype);
	});

	it('keeps presets genuinely named after inherited properties', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		writeConfigFile({
			modelPresets: { constructor: { worker: 'p/m:high' }, toString: { scout: 'p/n:low' } },
			defaultPreset: 'constructor',
		});
		const cfg = getConfig();
		expect(cfg.modelPresets).toEqual({
			constructor: { worker: 'p/m:high' },
			toString: { scout: 'p/n:low' },
		});
		expect(cfg.defaultPreset).toBe('constructor');
	});
});

describe('parseModelPresets', () => {
	it('returns an empty record for non-object input', () => {
		expect(parseModelPresets(undefined)).toEqual({});
		expect(parseModelPresets(null)).toEqual({});
		expect(parseModelPresets('nope')).toEqual({});
		expect(parseModelPresets(['x'])).toEqual({});
	});

	it('skips empty agent names and non-string specs', () => {
		expect(parseModelPresets({ p: { '': 'p/m', worker: 'p/m' } })).toEqual({
			p: { worker: 'p/m' },
		});
	});

	it('drops __proto__ keys at the preset and agent level', () => {
		const raw = JSON.parse(
			'{"__proto__":{"worker":"p/m:high"},"ok":{"__proto__":"x","worker":"p/m:low"}}',
		);
		expect(parseModelPresets(raw)).toEqual({ ok: { worker: 'p/m:low' } });
	});
});

describe('getConfig - invalid values', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('falls back to defaults for invalid values, keeping valid ones', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		writeConfigFile({
			maxParallelTasks: -1,
			maxConcurrency: 0,
			pollIntervalMs: 'fast',
			startupTimeoutMs: null,
			settleStabilityMs: Number.NaN,
			defaultAgentScope: 'weird',
			confirmProjectAgents: 'yes',
			herdrCliTimeoutMs: 1234,
		});
		const cfg = getConfig();
		expect(cfg.maxParallelTasks).toBe(DEFAULT_CONFIG.maxParallelTasks);
		expect(cfg.maxConcurrency).toBe(DEFAULT_CONFIG.maxConcurrency);
		expect(cfg.pollIntervalMs).toBe(DEFAULT_CONFIG.pollIntervalMs);
		expect(cfg.startupTimeoutMs).toBe(DEFAULT_CONFIG.startupTimeoutMs);
		expect(cfg.settleStabilityMs).toBe(DEFAULT_CONFIG.settleStabilityMs);
		expect(cfg.defaultAgentScope).toBe(DEFAULT_CONFIG.defaultAgentScope);
		expect(cfg.confirmProjectAgents).toBe(DEFAULT_CONFIG.confirmProjectAgents);
		expect(cfg.herdrCliTimeoutMs).toBe(1234);
	});
});
