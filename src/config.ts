import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { isValidModelSpec, normalizeModelSpec } from './model-spec.ts';
import type { EvidenceScope, RoleBudget, BudgetPolicy, CompositionPolicy } from './types.ts';
export type { CompositionPolicy } from './types.ts';

export type ConfigAgentScope = 'user' | 'project' | 'both';

export type ModelPreset = Record<string, string>;

export interface SubagentHerdrConfig {
	maxParallelTasks: number;
	maxConcurrency: number;
	pollIntervalMs: number;
	startupTimeoutMs: number;
	settleStabilityMs: number;
	statusLossTimeoutMs: number;
	/** Grace period after an abort before finishing. */
	abortGraceMs: number;
	steerTimeoutMs: number;
	/** Grace after which an open ui-prompt marker with an idle/done daemon is treated as a lost end marker. */
	uiPromptLostIdleMs: number;
	perTaskOutputCap: number;
	/** Estimated-token budget for the report digest delivered to the parent. */
	reportDigestTokens: number;
	/** Extra tool and discovery calls granted per path declared in a child's assigned scope. */
	scopeCallAllowancePerPath: number;
	/** Ceiling on the scope-derived allowance added to the tool and discovery budgets. */
	scopeCallAllowanceMax: number;
	/** How standard-role composition violations are handled before children are spawned. */
	compositionPolicy: CompositionPolicy;
	/** Ledger revisions kept per flow; the oldest are dropped when appending past this count. */
	ledgerMaxRevisions: number;
	registryLockTimeoutMs: number;
	registryLockStaleMs: number;
	herdrCliTimeoutMs: number;
	defaultAgentScope: ConfigAgentScope;
	confirmProjectAgents: boolean;
	/** Days a flow directory survives without a delegation before pruning removes it. */
	flowRetentionDays: number;
	/** Widest evidence scope a delegated child may reuse by default. */
	evidenceScopeDefault: EvidenceScope;
	/** Per-role overrides of evidenceScopeDefault. Empty means every role inherits the default. */
	evidenceScopeByRole: Record<string, EvidenceScope>;
	/** Roles whose children may run project commands that write to the repository. */
	mutatingCommandRoles: string[];
	/**
	 * Roles permitted to execute validation. Every other role may only resolve a tool-issued `verify`
	 * reference, so a `verify` call that is not a pure `{ ref }` lookup is refused for them. This is the
	 * knob that makes 'every other role may only resolve a reference' enforced rather than requested.
	 */
	validationExecutionRoles: string[];
	/**
	 * Serialize repository-writing project commands across delegated child sessions, and refuse a
	 * validation gate that would run while a sibling session holds a write in flight. Keyed by
	 * repository root, so it also covers two flows sharing one checkout. Exclusion fails open when the
	 * lock store is unusable, because a broken lock must not wedge every write in a flow.
	 */
	repositoryWriteLock: boolean;
	/** Per-agent live budgets. Unlisted roles use the default budget. */
	roleBudgets: Record<string, RoleBudget>;
	modelPresets: Record<string, ModelPreset>;
	defaultPreset?: string;
}

export function configPath(): string {
	return path.join(getAgentDir(), 'subagent-herdr.config.json');
}

const DEFAULT_ROLE_BUDGET: RoleBudget = {
	toolCalls: 24,
	discoveryCalls: 24,
	implementationDiscoveryCalls: 12,
	finalizationReserveCalls: 0,
	finalizationReserveValidationPasses: 0,
	fullValidationPasses: 2,
	failedToolCalls: 3,
	repeatedReads: 3,
	outputTokens: 1000,
	wallTimeMs: 10 * 60 * 1000,
	budgetPolicy: 'steer',
};

export const DEFAULT_ROLE_BUDGETS: Record<string, RoleBudget> = {
	scout: { ...DEFAULT_ROLE_BUDGET, toolCalls: 20, discoveryCalls: 8, outputTokens: 800 },
	planner: { ...DEFAULT_ROLE_BUDGET, toolCalls: 20, discoveryCalls: 6, outputTokens: 800 },
	worker: {
		...DEFAULT_ROLE_BUDGET,
		outputTokens: 1000,
		finalizationReserveCalls: 6,
		finalizationReserveValidationPasses: 1,
	},
	// A validator resolves the worker's `verify` ref first, so it executes at most what the ref does not
	// cover. The limit is three passes: the uncovered remainder, plus retries for flakiness and an
	// environment split. A validator that needs more is re-running evidence that already exists.
	validator: {
		...DEFAULT_ROLE_BUDGET,
		toolCalls: 20,
		discoveryCalls: 12,
		fullValidationPasses: 3,
		outputTokens: 800,
	},
	// A primary review pays for the flow ledger, the read manifest, the full diff, and one read per
	// in-scope path before it can write a finding, then still has to pay for the report. The call
	// budgets stay above that fixed cost and the report budget stays above the reviewer report
	// contract; scopeCallAllowancePerPath grows the call budgets with the declared scope size.
	reviewer: {
		...DEFAULT_ROLE_BUDGET,
		toolCalls: 32,
		discoveryCalls: 28,
		outputTokens: 4000,
	},
};

export const DEFAULT_MUTATING_COMMAND_ROLES: readonly string[] = ['worker'];

/**
 * Validation execution is owned by the session that changed files (`worker`) and, when the spawner
 * asks for independent execution, by `validator`. Declared before `DEFAULT_CONFIG` so the default is
 * initialized before the config object that references it is built.
 */
export const DEFAULT_VALIDATION_EXECUTION_ROLES: readonly string[] = ['worker', 'validator'];

export const DEFAULT_CONFIG: SubagentHerdrConfig = {
	maxParallelTasks: 8,
	maxConcurrency: 4,
	pollIntervalMs: 1500,
	startupTimeoutMs: 30_000,
	settleStabilityMs: 5000,
	statusLossTimeoutMs: 60_000,
	abortGraceMs: 60_000,
	steerTimeoutMs: 60_000,
	uiPromptLostIdleMs: 30_000,
	perTaskOutputCap: 50 * 1024,
	reportDigestTokens: 250,
	scopeCallAllowancePerPath: 2,
	scopeCallAllowanceMax: 32,
	compositionPolicy: 'warn',
	ledgerMaxRevisions: 12,
	registryLockTimeoutMs: 10_000,
	registryLockStaleMs: 5000,
	herdrCliTimeoutMs: 8000,
	defaultAgentScope: 'user',
	confirmProjectAgents: true,
	flowRetentionDays: 14,
	evidenceScopeDefault: 'flow',
	evidenceScopeByRole: {},
	mutatingCommandRoles: [...DEFAULT_MUTATING_COMMAND_ROLES],
	validationExecutionRoles: [...DEFAULT_VALIDATION_EXECUTION_ROLES],
	repositoryWriteLock: true,
	roleBudgets: DEFAULT_ROLE_BUDGETS,
	modelPresets: {},
};

// Every role inherits `flow` so validation evidence minted by the session that changed files resolves
// for its siblings. Independence is requested per delegation by narrowing to `session`, not owned here.
const DEFAULT_EVIDENCE_SCOPE_BY_ROLE: Record<string, EvidenceScope> = {};

const EVIDENCE_SCOPES = new Set<EvidenceScope>(['session', 'flow']);

const COMPOSITION_POLICIES = new Set<CompositionPolicy>(['warn', 'enforce', 'off']);
const BUDGET_POLICIES = new Set<BudgetPolicy>(['steer', 'abort']);
const BUDGET_KEYS = [
	'toolCalls',
	'discoveryCalls',
	'implementationDiscoveryCalls',
	'finalizationReserveCalls',
	'finalizationReserveValidationPasses',
	'fullValidationPasses',
	'failedToolCalls',
	'repeatedReads',
	'outputTokens',
	'wallTimeMs',
] as const satisfies readonly (keyof RoleBudget)[];

const NUMERIC_KEYS = [
	'maxParallelTasks',
	'maxConcurrency',
	'pollIntervalMs',
	'startupTimeoutMs',
	'settleStabilityMs',
	'statusLossTimeoutMs',
	'abortGraceMs',
	'steerTimeoutMs',
	'uiPromptLostIdleMs',
	'perTaskOutputCap',
	'registryLockTimeoutMs',
	'registryLockStaleMs',
	'herdrCliTimeoutMs',
	'flowRetentionDays',
	'reportDigestTokens',
	'scopeCallAllowancePerPath',
	'scopeCallAllowanceMax',
	'ledgerMaxRevisions',
] as const satisfies readonly (keyof SubagentHerdrConfig)[];

function parseEvidenceScopes(raw: unknown): Record<string, EvidenceScope> {
	const scopes: Record<string, EvidenceScope> = {};
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return scopes;
	for (const [role, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!role || role === '__proto__') continue;
		if (EVIDENCE_SCOPES.has(value as EvidenceScope)) scopes[role] = value as EvidenceScope;
	}
	return scopes;
}

function parseRoleNames(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const names: string[] = [];
	for (const value of raw) {
		if (typeof value !== 'string') continue;
		const name = value.trim();
		if (!name || name === '__proto__' || names.includes(name)) continue;
		names.push(name);
	}
	return names;
}

export function parseRoleBudgets(raw: unknown): Record<string, RoleBudget> {
	const budgets: Record<string, RoleBudget> = {};
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return budgets;
	for (const [role, value] of Object.entries(raw as Record<string, unknown>)) {
		if (
			!role ||
			role === '__proto__' ||
			typeof value !== 'object' ||
			value === null ||
			Array.isArray(value)
		)
			continue;
		const source = value as Record<string, unknown>;
		const base = { ...(DEFAULT_ROLE_BUDGETS[role] ?? DEFAULT_ROLE_BUDGET) };
		for (const key of BUDGET_KEYS) {
			const candidate = source[key];
			if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
				base[key] = candidate;
			}
		}
		if (BUDGET_POLICIES.has(source.budgetPolicy as BudgetPolicy))
			base.budgetPolicy = source.budgetPolicy as BudgetPolicy;
		budgets[role] = base;
	}
	return budgets;
}

export function roleBudgetFor(role: string, cfg: SubagentHerdrConfig = getConfig()): RoleBudget {
	return { ...(cfg.roleBudgets[role] ?? DEFAULT_ROLE_BUDGETS[role] ?? DEFAULT_ROLE_BUDGET) };
}

export function parseModelPresets(raw: unknown): Record<string, ModelPreset> {
	const presets: Record<string, ModelPreset> = {};
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return presets;
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!name || name === '__proto__') continue;
		if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
		const preset: ModelPreset = {};
		for (const [agentName, spec] of Object.entries(value as Record<string, unknown>)) {
			if (!agentName || agentName === '__proto__') continue;
			if (typeof spec !== 'string' || !isValidModelSpec(spec)) continue;
			preset[agentName] = normalizeModelSpec(spec);
		}
		if (Object.keys(preset).length > 0) presets[name] = preset;
	}
	return presets;
}

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
	if (typeof overrides.repositoryWriteLock === 'boolean') {
		cfg.repositoryWriteLock = overrides.repositoryWriteLock;
	}
	if (EVIDENCE_SCOPES.has(overrides.evidenceScopeDefault as EvidenceScope)) {
		cfg.evidenceScopeDefault = overrides.evidenceScopeDefault as EvidenceScope;
	}
	if (COMPOSITION_POLICIES.has(overrides.compositionPolicy as CompositionPolicy)) {
		cfg.compositionPolicy = overrides.compositionPolicy as CompositionPolicy;
	}
	cfg.evidenceScopeByRole = {
		...DEFAULT_EVIDENCE_SCOPE_BY_ROLE,
		...parseEvidenceScopes(overrides.evidenceScopeByRole),
	};
	cfg.mutatingCommandRoles = Array.isArray(overrides.mutatingCommandRoles)
		? parseRoleNames(overrides.mutatingCommandRoles)
		: [...DEFAULT_MUTATING_COMMAND_ROLES];
	cfg.validationExecutionRoles = Array.isArray(overrides.validationExecutionRoles)
		? parseRoleNames(overrides.validationExecutionRoles)
		: [...DEFAULT_VALIDATION_EXECUTION_ROLES];
	cfg.roleBudgets = {
		...DEFAULT_ROLE_BUDGETS,
		...parseRoleBudgets(overrides.roleBudgets),
	};
	cfg.modelPresets = parseModelPresets(overrides.modelPresets);
	if (
		typeof overrides.defaultPreset === 'string' &&
		Object.hasOwn(cfg.modelPresets, overrides.defaultPreset)
	) {
		cfg.defaultPreset = overrides.defaultPreset;
	}
	return cfg;
}
