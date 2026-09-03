import { randomUUID } from 'node:crypto';
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	TurnEndEvent,
} from '@earendil-works/pi-coding-agent';
import { getConfig, roleBudgetFor } from './config.ts';
import { ENV_FLOW } from './delegation.ts';
import { updateRegistryEntry } from './registry.ts';
import type {
	BudgetBreach,
	BudgetMetric,
	BudgetSummary,
	BudgetUsage,
	RoleBudget,
} from './types.ts';

const DISCOVERY_TOOLS = new Set([
	'grep',
	'find',
	'ls',
	'read',
	'git_status',
	'git_diff',
	'git_log',
	'git_show',
	'codegraph_explore',
	'codegraph_callers',
	'codegraph_callees',
	'codegraph_impact',
	'codegraph_affected',
	'resolve-library-id',
	'query-docs',
]);

const VALIDATION_COMMANDS = new Set([
	'node_test',
	'node_build',
	'node_lint',
	'node_typecheck',
	'node_format',
	'fallow_dead_code',
	'fallow_dupes',
	'fallow_health',
	'fallow_audit',
]);

const DISCOVERY_COMMANDS = new Set([
	'workspace_path',
	'node_version',
	'node_project_info',
	'node_deps_list',
	'fallow_list_entry_points',
	'fallow_list_boundaries',
]);

export const BUDGET_STEER_PREFIX = '[herdr budget enforcement]';
export const BUDGET_STEER_MESSAGE = `${BUDGET_STEER_PREFIX} A per-role budget was exhausted. Stop all implementation and validation work. Read the supplied flow ledger or report only if needed, then return the required compact ledger contribution and final report.`;

function noopAbort(): void {}

export function emptyBudgetUsage(): BudgetUsage {
	return {
		toolCalls: 0,
		discoveryCalls: 0,
		fullValidationPasses: 0,
		failedToolCalls: 0,
		repeatedReads: 0,
		outputTokens: 0,
		wallTimeMs: 0,
	};
}

export function classifyToolCall(
	name: string,
	input: Record<string, unknown> | undefined,
): 'discovery' | 'validation' | undefined {
	if (name === 'project_command') {
		const commandId = typeof input?.commandId === 'string' ? input.commandId : '';
		if (VALIDATION_COMMANDS.has(commandId)) return 'validation';
		if (DISCOVERY_COMMANDS.has(commandId)) return 'discovery';
		return undefined;
	}
	return DISCOVERY_TOOLS.has(name) ? 'discovery' : undefined;
}

export function readRequestKey(input: Record<string, unknown>): string | undefined {
	const filePath = typeof input.file_path === 'string' ? input.file_path : input.path;
	if (typeof filePath !== 'string') return undefined;
	return `${filePath}:${String(input.offset ?? '')}:${String(input.limit ?? '')}`;
}

export function readPathOf(input: Record<string, unknown> | undefined): string | undefined {
	const value = input?.file_path ?? input?.path;
	return typeof value === 'string' ? value : undefined;
}

export function isReportRead(
	name: string,
	input: Record<string, unknown> | undefined,
	flowId?: string,
): boolean {
	if (name !== 'read' || !flowId) return false;
	const raw = readPathOf(input);
	if (!raw) return false;
	const segments = raw.replaceAll('\\', '/').split('/').filter(Boolean);
	return segments.some((segment, index) => {
		if (segment !== 'flows' || !segments[index + 1]) return false;
		if (segments[index + 1] !== flowId) return false;
		const next = segments[index + 2];
		if (next === 'ledger.md') return index + 3 === segments.length;
		return (
			next === 'reports' &&
			Boolean(segments[index + 3]?.endsWith('.md')) &&
			index + 4 === segments.length
		);
	});
}

const USAGE_TO_LIMIT: ReadonlyArray<[BudgetMetric, keyof BudgetUsage]> = [
	['toolCalls', 'toolCalls'],
	['discoveryCalls', 'discoveryCalls'],
	['fullValidationPasses', 'fullValidationPasses'],
	['failedToolCalls', 'failedToolCalls'],
	['repeatedReads', 'repeatedReads'],
	['outputTokens', 'outputTokens'],
	['wallTimeMs', 'wallTimeMs'],
];

function budgetSummary(
	role: string,
	limits: RoleBudget,
	usage: BudgetUsage,
	breaches: BudgetBreach[],
	outcome: BudgetSummary['outcome'],
	steerIssued: boolean,
	reportOnly: boolean,
	automaticSteerId?: string,
): BudgetSummary {
	return {
		role,
		limits: { ...limits },
		usage: { ...usage },
		outcome,
		breaches: breaches.map((breach) => ({ ...breach })),
		steerIssued,
		reportOnly,
		automaticSteerId,
	};
}

export function budgetSummaryFromMetrics(
	role: string,
	limits: RoleBudget,
	usage: BudgetUsage,
	existing?: BudgetSummary,
): BudgetSummary {
	const breaches =
		existing?.breaches ??
		USAGE_TO_LIMIT.filter(([, usageKey]) => usage[usageKey] > limits[usageKey]).map(
			([metric, usageKey]) => ({
				metric,
				limit: limits[usageKey],
				observed: usage[usageKey],
				at: Date.now(),
			}),
		);
	return budgetSummary(
		role,
		limits,
		usage,
		breaches,
		existing?.outcome ?? (breaches.length > 0 ? 'report_only' : 'within'),
		existing?.steerIssued ?? false,
		existing?.reportOnly ?? false,
		existing?.automaticSteerId,
	);
}

interface MutableBudgetState {
	role: string;
	limits: RoleBudget;
	usage: BudgetUsage;
	breaches: BudgetBreach[];
	outcome: BudgetSummary['outcome'];
	steerIssued: boolean;
	reportOnly: boolean;
	automaticSteerPending: boolean;
	automaticSteerId?: string;
}

function currentBreach(state: MutableBudgetState): BudgetBreach | undefined {
	for (const [metric, usageKey] of USAGE_TO_LIMIT) {
		const observed = state.usage[usageKey];
		const limit = state.limits[metric];
		if (observed > limit && !state.breaches.some((breach) => breach.metric === metric)) {
			return { metric, limit, observed, at: Date.now() };
		}
	}
	return undefined;
}

function summaryOf(state: MutableBudgetState): BudgetSummary {
	return budgetSummary(
		state.role,
		state.limits,
		state.usage,
		state.breaches,
		state.outcome,
		state.steerIssued,
		state.reportOnly,
		state.automaticSteerId,
	);
}

function persist(label: string | undefined, state: MutableBudgetState): void {
	if (!label) return;
	updateRegistryEntry(label, { budget: summaryOf(state), updatedAt: Date.now() });
}

function addCurrentBreach(state: MutableBudgetState): BudgetBreach | undefined {
	const breach = currentBreach(state);
	if (!breach) return undefined;
	state.breaches.push(breach);
	return breach;
}

function resetTurn(state: MutableBudgetState): void {
	state.usage = emptyBudgetUsage();
	state.breaches = [];
	state.outcome = 'within';
	state.steerIssued = false;
	state.reportOnly = false;
	state.automaticSteerPending = false;
	state.automaticSteerId = undefined;
}

function abortForBudget(ctx: { abort(): void }, state: MutableBudgetState): void {
	state.outcome = 'aborted';
	ctx.abort();
}

function steerForBudget(
	pi: Pick<ExtensionAPI, 'sendUserMessage'>,
	state: MutableBudgetState,
	beforeSend?: () => void,
): void {
	if (state.steerIssued) return;
	state.steerIssued = true;
	state.reportOnly = true;
	state.outcome = 'steered';
	state.automaticSteerPending = true;
	state.automaticSteerId = randomUUID();
	beforeSend?.();
	pi.sendUserMessage(`${BUDGET_STEER_MESSAGE} [${state.automaticSteerId}]`, {
		deliverAs: 'steer',
	});
}

function enforceNewBreach(
	pi: Pick<ExtensionAPI, 'sendUserMessage'>,
	ctx: { abort(): void },
	state: MutableBudgetState,
	beforeSteer?: () => void,
): boolean {
	const breach = addCurrentBreach(state);
	if (!breach) return false;
	if (state.limits.budgetPolicy === 'abort') abortForBudget(ctx, state);
	else steerForBudget(pi, state, beforeSteer);
	return true;
}

export function registerBudgetEnforcement(pi: ExtensionAPI): void {
	if (process.env.PI_SUBAGENT_NESTED !== '1') return;
	const role = process.env.PI_ORCHESTRATION_ROLE;
	if (!role) return;
	const label = process.env.PI_SUBAGENT_LABEL;
	const flowId = process.env[ENV_FLOW];
	const limits = roleBudgetFor(role, getConfig());
	const state: MutableBudgetState = {
		role,
		limits,
		usage: emptyBudgetUsage(),
		breaches: [],
		outcome: 'within',
		steerIssued: false,
		reportOnly: false,
		automaticSteerPending: false,
	};
	let turnStartedAt = Date.now();
	let wallTimer: ReturnType<typeof setTimeout> | undefined;
	let preserveTurnDeadline = false;
	let abortCurrent = noopAbort;
	const readKeys = new Map<string, number>();

	const clearWallTimer = (): void => {
		if (wallTimer !== undefined) {
			clearTimeout(wallTimer);
			wallTimer = undefined;
		}
	};

	const armWallTimer = (): void => {
		clearWallTimer();
		const startedAt = turnStartedAt;
		const elapsed = Math.max(0, Date.now() - startedAt);
		const delay = Math.max(1, limits.wallTimeMs - elapsed + 1);
		wallTimer = setTimeout(() => {
			wallTimer = undefined;
			if (startedAt !== turnStartedAt) return;
			state.usage.wallTimeMs = Math.max(state.usage.wallTimeMs, Date.now() - startedAt);
			enforceNewBreach(pi, { abort: abortCurrent }, state, () => persist(label, state));
			persist(label, state);
		}, delay);
	};

	pi.on('before_agent_start', (event: BeforeAgentStartEvent, ctx) => {
		abortCurrent = ctx.abort;
		if (state.automaticSteerPending && event.prompt.startsWith(BUDGET_STEER_PREFIX)) {
			state.automaticSteerPending = false;
			preserveTurnDeadline = true;
			armWallTimer();
			persist(label, state);
			return;
		}
		resetTurn(state);
		readKeys.clear();
		preserveTurnDeadline = false;
		turnStartedAt = Date.now();
		armWallTimer();
		persist(label, state);
	});

	pi.on('tool_call', (event: ToolCallEvent, ctx): ToolCallEventResult | undefined => {
		abortCurrent = ctx.abort;
		state.usage.wallTimeMs = Math.max(state.usage.wallTimeMs, Date.now() - turnStartedAt);
		state.usage.toolCalls++;
		const category = classifyToolCall(event.toolName, event.input);
		if (category === 'discovery') state.usage.discoveryCalls++;
		if (category === 'validation') state.usage.fullValidationPasses++;
		if (event.toolName === 'read') {
			const key = readRequestKey(event.input);
			if (key) {
				const prior = readKeys.get(key) ?? 0;
				if (prior > 0) state.usage.repeatedReads++;
				readKeys.set(key, prior + 1);
			}
		}
		const breached = enforceNewBreach(pi, ctx, state, () => persist(label, state));
		persist(label, state);
		if (state.outcome === 'aborted')
			return {
				block: true,
				reason: `Budget exhausted for role ${role}: ${state.breaches.at(-1)?.metric}`,
			};
		if (state.reportOnly && !isReportRead(event.toolName, event.input, flowId)) {
			state.outcome = breached ? 'steered' : 'report_only';
			persist(label, state);
			return {
				block: true,
				reason: `Budget exhausted for role ${role}; only ledger/report reads are allowed`,
			};
		}
		if (breached && !isReportRead(event.toolName, event.input, flowId)) {
			return {
				block: true,
				reason: `Budget exhausted for role ${role}: ${state.breaches.at(-1)?.metric}`,
			};
		}
		return undefined;
	});

	pi.on('tool_result', (event: ToolResultEvent, ctx) => {
		abortCurrent = ctx.abort;
		if (event.isError) state.usage.failedToolCalls++;
		enforceNewBreach(pi, ctx, state, () => persist(label, state));
		persist(label, state);
	});

	pi.on('turn_end', (event: TurnEndEvent, ctx) => {
		abortCurrent = ctx.abort;
		if (event.message.role === 'assistant')
			state.usage.outputTokens += event.message.usage?.output ?? 0;
		state.usage.wallTimeMs = Math.max(state.usage.wallTimeMs, Date.now() - turnStartedAt);
		enforceNewBreach(pi, ctx, state, () => persist(label, state));
		persist(label, state);
	});

	pi.on('agent_end', () => clearWallTimer());
	pi.on('agent_settled', () => {
		clearWallTimer();
		persist(label, state);
	});

	pi.on('turn_start', () => {
		if (!preserveTurnDeadline) turnStartedAt = Date.now();
		preserveTurnDeadline = false;
		armWallTimer();
	});
}
