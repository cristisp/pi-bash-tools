import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.ts';
import {
	type FindModel,
	effectivePresetName,
	filterAvailableModels,
	findModelFrom,
	formatPresetSummary,
	PRESET_ENTRY_TYPE,
	readPresetOverride,
	unavailableModelsByPreset,
} from '../src/presets.ts';

function cfgWith(
	overrides: Partial<{
		modelPresets: Record<string, Record<string, string>>;
		defaultPreset: string;
	}>,
) {
	return { ...DEFAULT_CONFIG, ...overrides };
}

const entry = (preset: unknown) => ({
	type: 'custom',
	customType: PRESET_ENTRY_TYPE,
	data: { preset },
});

describe('readPresetOverride', () => {
	it('returns undefined when there is no session manager or no entries', () => {
		expect(readPresetOverride(undefined)).toBeUndefined();
		expect(readPresetOverride({})).toBeUndefined();
		expect(readPresetOverride({ getEntries: () => 'nope' })).toBeUndefined();
		expect(readPresetOverride({ getEntries: () => [] })).toBeUndefined();
	});

	it('prefers getBranch over getEntries', () => {
		const sm = {
			getBranch: () => [entry('branch-preset')],
			getEntries: () => [entry('entries-preset')],
		};
		expect(readPresetOverride(sm)).toBe('branch-preset');
	});

	it('falls back to getEntries when getBranch is absent', () => {
		const sm = { getEntries: () => [{ type: 'message' }, entry('worker-pool')] };
		expect(readPresetOverride(sm)).toBe('worker-pool');
	});

	it('returns the last matching entry', () => {
		const sm = { getEntries: () => [entry('first'), { type: 'message' }, entry('second')] };
		expect(readPresetOverride(sm)).toBe('second');
	});

	it('returns null when the last entry cleared the override', () => {
		const sm = { getEntries: () => [entry('first'), entry(null)] };
		expect(readPresetOverride(sm)).toBeNull();
	});

	it('ignores entries with malformed data', () => {
		const sm = {
			getEntries: () => [{ type: 'custom', customType: PRESET_ENTRY_TYPE, data: {} }],
		};
		expect(readPresetOverride(sm)).toBeUndefined();
	});

	it('keeps an earlier valid selection when a later entry is malformed', () => {
		const sm = {
			getEntries: () => [
				entry('deep'),
				{ type: 'custom', customType: PRESET_ENTRY_TYPE, data: {} },
			],
		};
		expect(readPresetOverride(sm)).toBe('deep');
	});

	it('keeps an earlier valid selection when a later entry has non-object data', () => {
		const sm = {
			getEntries: () => [
				entry('deep'),
				{ type: 'custom', customType: PRESET_ENTRY_TYPE, data: 'corrupt' },
			],
		};
		expect(readPresetOverride(sm)).toBe('deep');
	});
});

describe('effectivePresetName', () => {
	const cfg = cfgWith({
		modelPresets: { fast: { worker: 'p/m:low' }, deep: { worker: 'p/m:high' } },
		defaultPreset: 'fast',
	});

	it('uses the session override when it names a configured preset', () => {
		expect(effectivePresetName('deep', cfg)).toBe('deep');
	});

	it('falls back to the config default preset without an override', () => {
		expect(effectivePresetName(undefined, cfg)).toBe('fast');
		expect(effectivePresetName(null, cfg)).toBe('fast');
	});

	it('falls back to the config default when the override is stale', () => {
		expect(effectivePresetName('removed-preset', cfg)).toBe('fast');
	});

	it('returns undefined without any usable preset', () => {
		expect(effectivePresetName(undefined, cfgWith({}))).toBeUndefined();
		expect(effectivePresetName(undefined, cfgWith({ defaultPreset: 'ghost' }))).toBeUndefined();
	});

	it('ignores inherited names that are not configured presets', () => {
		const empty = cfgWith({ defaultPreset: 'toString' });
		expect(effectivePresetName(undefined, empty)).toBeUndefined();
		expect(effectivePresetName('constructor', empty)).toBeUndefined();
		expect(effectivePresetName('toString', empty)).toBeUndefined();
	});

	it('accepts presets genuinely named after inherited properties', () => {
		const ownKeyCfg = cfgWith({
			modelPresets: { ['constructor']: { worker: 'p/m:high' } },
			defaultPreset: 'constructor',
		});
		expect(effectivePresetName(undefined, ownKeyCfg)).toBe('constructor');
		expect(effectivePresetName('constructor', ownKeyCfg)).toBe('constructor');
	});
});

describe('findModelFrom', () => {
	it('wraps a registry find and returns undefined for missing registries', () => {
		expect(findModelFrom(undefined)).toBeUndefined();
		expect(findModelFrom({})).toBeUndefined();
		expect(findModelFrom({ find: 'nope' })).toBeUndefined();
		const registry = { find: (p: string, m: string) => `${p}/${m}` };
		const find = findModelFrom(registry)!;
		expect(find('prov', 'model-1')).toBe('prov/model-1');
	});
});

const goneModelFind: FindModel = (_provider, modelId) => (modelId === 'gone' ? undefined : {});
const goneModelsFind: FindModel = (_provider, modelId) =>
	modelId.includes('gone') ? undefined : {};

describe('filterAvailableModels', () => {
	const entries = { worker: 'p/worker:high', scout: 'p/gone:low' };

	it('partitions entries into available and unavailable', () => {
		const { available, unavailable } = filterAvailableModels(entries, goneModelFind);
		expect(available).toEqual({ worker: 'p/worker:high' });
		expect(unavailable).toEqual({ scout: 'p/gone:low' });
	});

	it('fails open when no registry lookup is available', () => {
		const { available, unavailable } = filterAvailableModels(entries, undefined);
		expect(available).toEqual(entries);
		expect(unavailable).toEqual({});
	});

	it('returns empty maps for missing entries', () => {
		const { available, unavailable } = filterAvailableModels(undefined, goneModelFind);
		expect(available).toEqual({});
		expect(unavailable).toEqual({});
	});

	it('drops __proto__ entries instead of polluting the result maps', () => {
		const malicious = { ['__proto__']: 'p/evil:high', worker: 'p/w:low' };
		const { available, unavailable } = filterAvailableModels(malicious, goneModelFind);
		expect(available).toEqual({ worker: 'p/w:low' });
		expect(unavailable).toEqual({});
		expect(Object.getPrototypeOf(available)).toBeNull();
		expect(Object.getPrototypeOf(unavailable)).toBeNull();
	});
});

describe('unavailableModelsByPreset', () => {
	it('collects unavailable entries per preset', () => {
		const cfg = cfgWith({
			modelPresets: {
				ok: { worker: 'p/ok:high' },
				stale: { worker: 'p/gone:low', scout: 'p/also-gone:low' },
				partial: { planner: 'p/ok:high', reviewer: 'p/gone:high' },
			},
		});
		const findModel = goneModelsFind;
		expect(unavailableModelsByPreset(cfg, findModel)).toEqual({
			stale: { worker: 'p/gone:low', scout: 'p/also-gone:low' },
			partial: { reviewer: 'p/gone:high' },
		});
	});

	it('returns an empty record when all models resolve', () => {
		const cfg = cfgWith({ modelPresets: { ok: { worker: 'p/ok:high' } } });
		expect(unavailableModelsByPreset(cfg, () => ({}))).toEqual({});
	});
});

describe('formatPresetSummary', () => {
	it('formats agent/model pairs in brackets', () => {
		expect(formatPresetSummary({ planner: 'p/m:high', worker: 'p/n:low' })).toBe(
			'[planner: p/m:high, worker: p/n:low]',
		);
	});

	it('returns an empty string for missing presets', () => {
		expect(formatPresetSummary(undefined)).toBe('');
		expect(formatPresetSummary({})).toBe('[]');
	});
});
