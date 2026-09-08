import * as fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	configPath,
	DEFAULT_CONFIG,
	DEFAULT_MUTATING_COMMAND_ROLES,
	DEFAULT_ROLE_BUDGETS,
	DEFAULT_VALIDATION_EXECUTION_ROLES,
	getConfig,
	parseModelPresets,
	parseRoleBudgets,
} from '../src/config.ts';
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
		expect(DEFAULT_CONFIG.reportDigestTokens).toBe(250);
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
			reportDigestTokens: 400,
			scopeCallAllowancePerPath: 3,
			scopeCallAllowanceMax: 64,
			reportContractPolicy: 'reject',
			compositionPolicy: 'enforce',
			ledgerMaxRevisions: 25,
			ledgerPointers: false,
			registryLockTimeoutMs: 2000,
			registryLockStaleMs: 1000,
			herdrCliTimeoutMs: 4000,
			defaultAgentScope: 'both',
			confirmProjectAgents: false,
			flowRetentionDays: 7,
			evidenceScopeDefault: 'session',
			evidenceScopeByRole: { validator: 'session' },
			mutatingCommandRoles: ['worker', 'implementer'],
			validationExecutionRoles: ['worker'],
			repositoryWriteLock: false,
			roleBudgets: DEFAULT_ROLE_BUDGETS,
			modelPresets: { fast: { worker: 'p/m:high' } },
			defaultPreset: 'fast',
		};
		writeConfigFile(overrides);
		expect(getConfig()).toEqual(overrides);
	});

	it('parses composition policies and safely falls back for invalid values', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		expect(DEFAULT_CONFIG.compositionPolicy).toBe('warn');
		for (const policy of ['warn', 'enforce', 'off'] as const) {
			writeConfigFile({ compositionPolicy: policy });
			expect(getConfig().compositionPolicy).toBe(policy);
		}
		writeConfigFile({ compositionPolicy: 'ignore' });
		expect(getConfig().compositionPolicy).toBe('warn');
		writeConfigFile({ compositionPolicy: 42 });
		expect(getConfig().compositionPolicy).toBe('warn');
	});

	it('falls back to defaults for invalid report contract values', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		writeConfigFile({ reportDigestTokens: 0, reportContractPolicy: 'ignore' });
		const cfg = getConfig();
		expect(cfg.reportDigestTokens).toBe(DEFAULT_CONFIG.reportDigestTokens);
		expect(cfg.reportContractPolicy).toBe('flag');
	});

	it('keeps every role on the default evidence scope and honours explicit narrowing', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		expect(getConfig().evidenceScopeByRole).toEqual({});
		writeConfigFile({ evidenceScopeByRole: { validator: 'session' } });
		expect(getConfig().evidenceScopeByRole).toEqual({ validator: 'session' });
	});

	it('drops invalid mutating command role names and keeps an explicit empty list', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		writeConfigFile({ mutatingCommandRoles: ['worker', '', 7, ' worker '] });
		expect(getConfig().mutatingCommandRoles).toEqual(['worker']);
		writeConfigFile({ mutatingCommandRoles: [] });
		expect(getConfig().mutatingCommandRoles).toEqual([]);
		writeConfigFile({ mutatingCommandRoles: 'worker' });
		expect(getConfig().mutatingCommandRoles).toEqual([...DEFAULT_MUTATING_COMMAND_ROLES]);
	});

	it('defaults validation execution to worker and validator and lets a config list narrow it', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		expect(DEFAULT_VALIDATION_EXECUTION_ROLES).toEqual(['worker', 'validator']);
		expect(getConfig().validationExecutionRoles).toEqual(['worker', 'validator']);
		writeConfigFile({ validationExecutionRoles: [' validator ', '', 7, 'validator'] });
		expect(getConfig().validationExecutionRoles).toEqual(['validator']);
		writeConfigFile({ validationExecutionRoles: [] });
		expect(getConfig().validationExecutionRoles).toEqual([]);
		writeConfigFile({ validationExecutionRoles: 'worker' });
		const fallback = [...DEFAULT_VALIDATION_EXECUTION_ROLES];
		expect(getConfig().validationExecutionRoles).toEqual(fallback);
	});

	it('defaults the sibling write exclusion on and lets a config disable it', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		expect(getConfig().repositoryWriteLock).toBe(true);
		writeConfigFile({ repositoryWriteLock: false });
		expect(getConfig().repositoryWriteLock).toBe(false);
		writeConfigFile({ repositoryWriteLock: 'no' });
		expect(getConfig().repositoryWriteLock).toBe(true);
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

describe('DEFAULT_ROLE_BUDGETS', () => {
	it('covers the fixed inspection cost of a scoped review before any finding is written', () => {
		const reviewer = DEFAULT_ROLE_BUDGETS.reviewer;
		// Flow ledger, read manifest, full diff, then one read per in-scope path.
		const fixedInspections = 3;
		const scopePaths = 10;
		expect(reviewer.toolCalls).toBeGreaterThan(fixedInspections + scopePaths);
		expect(reviewer.discoveryCalls).toBeGreaterThan(fixedInspections + scopePaths);
		expect(reviewer.discoveryCalls).toBeLessThan(reviewer.toolCalls);
	});

	it('budgets more report output than a reviewer report contract needs', () => {
		expect(DEFAULT_ROLE_BUDGETS.reviewer.outputTokens).toBeGreaterThanOrEqual(4000);
	});

	it('grants scope-scaled inspections on top of every role budget', () => {
		expect(DEFAULT_CONFIG.scopeCallAllowancePerPath).toBeGreaterThan(0);
		expect(DEFAULT_CONFIG.scopeCallAllowanceMax).toBeGreaterThanOrEqual(16);
	});
});

describe('parseRoleBudgets', () => {
	it('merges valid role limits with role defaults and ignores invalid values', () => {
		expect(
			parseRoleBudgets({
				worker: {
					toolCalls: 40,
					implementationDiscoveryCalls: 5,
					outputTokens: 1200,
					budgetPolicy: 'abort',
					failedToolCalls: -1,
				},
				bad: 'nope',
				__proto__: { toolCalls: 1 },
			}),
		).toEqual({
			worker: {
				...DEFAULT_ROLE_BUDGETS.worker,
				toolCalls: 40,
				outputTokens: 1200,
				implementationDiscoveryCalls: 5,
				budgetPolicy: 'abort',
			},
		});
	});

	it('returns an empty record for malformed input', () => {
		expect(parseRoleBudgets(undefined)).toEqual({});
		expect(parseRoleBudgets(null)).toEqual({});
		expect(parseRoleBudgets('nope')).toEqual({});
		expect(parseRoleBudgets([])).toEqual({});
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
