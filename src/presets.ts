import type { ModelPreset, SubagentHerdrConfig } from './config.ts';
import { splitModelSpec } from './model-spec.ts';

export const PRESET_ENTRY_TYPE = 'subagent-herdr-preset';

export type PresetOverride = string | null | undefined;

export type FindModel = (provider: string, modelId: string) => unknown;

interface SessionManagerLike {
	getBranch?: () => unknown[];
	getEntries?: () => unknown[];
}

export function readPresetOverride(sessionManager: unknown): PresetOverride {
	if (!sessionManager || typeof sessionManager !== 'object') return undefined;
	const mgr = sessionManager as SessionManagerLike;
	let entries: unknown;
	if (typeof mgr.getBranch === 'function') entries = mgr.getBranch();
	else if (typeof mgr.getEntries === 'function') entries = mgr.getEntries();
	else return undefined;
	if (!Array.isArray(entries)) return undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as
			| { type?: unknown; customType?: unknown; data?: { preset?: unknown } }
			| undefined;
		if (!entry || entry.type !== 'custom' || entry.customType !== PRESET_ENTRY_TYPE) continue;
		const preset = entry.data?.preset;
		if (typeof preset === 'string') return preset;
		if (preset === null) return null;
	}
	return undefined;
}

export function effectivePresetName(
	override: PresetOverride,
	cfg: SubagentHerdrConfig,
): string | undefined {
	if (override && Object.hasOwn(cfg.modelPresets, override)) return override;
	if (cfg.defaultPreset && Object.hasOwn(cfg.modelPresets, cfg.defaultPreset)) {
		return cfg.defaultPreset;
	}
	return undefined;
}

export function findModelFrom(registry: unknown): FindModel | undefined {
	if (!registry || typeof registry !== 'object') return undefined;
	const find = (registry as { find?: unknown }).find;
	if (typeof find !== 'function') return undefined;
	return (provider: string, modelId: string) =>
		(find as FindModel).call(registry, provider, modelId);
}

export function filterAvailableModels(
	entries: ModelPreset | undefined,
	findModel: FindModel | undefined,
): { available: ModelPreset; unavailable: ModelPreset } {
	const available = Object.create(null) as ModelPreset;
	const unavailable = Object.create(null) as ModelPreset;
	if (!entries) return { available, unavailable };
	for (const [agent, spec] of Object.entries(entries)) {
		if (agent === '__proto__') continue;
		if (!findModel) {
			available[agent] = spec;
			continue;
		}
		const parts = splitModelSpec(spec);
		if (parts && findModel(parts.provider, parts.modelId)) available[agent] = spec;
		else unavailable[agent] = spec;
	}
	return { available, unavailable };
}

export function unavailableModelsByPreset(
	cfg: SubagentHerdrConfig,
	findModel: FindModel | undefined,
): Record<string, ModelPreset> {
	const stale: Record<string, ModelPreset> = {};
	for (const [name, entries] of Object.entries(cfg.modelPresets)) {
		const { unavailable } = filterAvailableModels(entries, findModel);
		if (Object.keys(unavailable).length > 0) stale[name] = unavailable;
	}
	return stale;
}

export function formatPresetSummary(preset: Record<string, string> | undefined): string {
	if (!preset) return '';
	const entries = Object.entries(preset).map(([agent, model]) => `${agent}: ${model}`);
	return `[${entries.join(', ')}]`;
}
