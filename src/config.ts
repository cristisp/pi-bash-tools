import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export type ConfigAgentScope = 'user' | 'project' | 'both';

export interface SubagentHerdrConfig {
	maxParallelTasks: number;
	maxConcurrency: number;
	pollIntervalMs: number;
	startupTimeoutMs: number;
	settleStabilityMs: number;
	statusLossTimeoutMs: number;
	abortGraceMs: number;
	steerTimeoutMs: number;
	perTaskOutputCap: number;
	registryLockTimeoutMs: number;
	registryLockStaleMs: number;
	herdrCliTimeoutMs: number;
	defaultAgentScope: ConfigAgentScope;
	confirmProjectAgents: boolean;
}

export function configPath(): string {
	return path.join(getAgentDir(), 'subagent-herdr.config.json');
}

export const DEFAULT_CONFIG: SubagentHerdrConfig = {
	maxParallelTasks: 8,
	maxConcurrency: 4,
	pollIntervalMs: 1500,
	startupTimeoutMs: 30_000,
	settleStabilityMs: 5000,
	statusLossTimeoutMs: 60_000,
	abortGraceMs: 60_000,
	steerTimeoutMs: 60_000,
	perTaskOutputCap: 50 * 1024,
	registryLockTimeoutMs: 10_000,
	registryLockStaleMs: 5000,
	herdrCliTimeoutMs: 8000,
	defaultAgentScope: 'user',
	confirmProjectAgents: true,
};

const NUMERIC_KEYS = [
	'maxParallelTasks',
	'maxConcurrency',
	'pollIntervalMs',
	'startupTimeoutMs',
	'settleStabilityMs',
	'statusLossTimeoutMs',
	'abortGraceMs',
	'steerTimeoutMs',
	'perTaskOutputCap',
	'registryLockTimeoutMs',
	'registryLockStaleMs',
	'herdrCliTimeoutMs',
] as const satisfies readonly (keyof SubagentHerdrConfig)[];

export function getConfig(filePath?: string): SubagentHerdrConfig {
	const cfg = { ...DEFAULT_CONFIG };
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(filePath ?? configPath(), 'utf-8'));
	} catch {
		return cfg;
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return cfg;
	const overrides = raw as Record<string, unknown>;
	for (const key of NUMERIC_KEYS) {
		const value = overrides[key];
		if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
			cfg[key] = value;
		}
	}
	if (
		overrides.defaultAgentScope === 'user' ||
		overrides.defaultAgentScope === 'project' ||
		overrides.defaultAgentScope === 'both'
	) {
		cfg.defaultAgentScope = overrides.defaultAgentScope;
	}
	if (typeof overrides.confirmProjectAgents === 'boolean') {
		cfg.confirmProjectAgents = overrides.confirmProjectAgents;
	}
	return cfg;
}
