import * as fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configPath, DEFAULT_CONFIG, getConfig } from '../src/config.ts';
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
		};
		writeConfigFile(overrides);
		expect(getConfig()).toEqual(overrides);
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
