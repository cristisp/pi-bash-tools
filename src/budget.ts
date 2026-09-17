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
import type { SubagentHerdrConfig } from './config.ts';
import { ENV_FLOW, ENV_SCOPE_PATHS } from './delegation.ts';
import {
	acquireRepositoryWriteLock,
	probeRepositoryWriteLock,
	releaseRepositoryWriteLock,
} from './repo-lock.ts';
import type { RepositoryWriteContention, RepositoryWriteLockHandle } from './repo-lock.ts';
import { updateRegistryEntry } from './registry.ts';
import type {
	BudgetBreach,
	BudgetCause,
	BudgetMetric,
	BudgetPhase,
	BudgetSummary,
	BudgetUsage,
	RoleBudget,
} from './types.ts';

const IMPLEMENTATION_TOOLS = new Set(['edit', 'write', 'move', 'delete']);

const DISCOVERY_TOOLS = new Set([
	'grep',
	'find',
	'ls',
	'read',
	'read_batch',
	'git_status',
	'git_diff',
	'git_log',
	'git_show',
	'codegraph_explore',
	'codegraph_callers',
	'codegraph_callees',
	'codegraph_impact',
	'codegraph_affected',
	'codegraph_sync',
	'codegraph_artifact',
	'resolve-library-id',
	'query-docs',
	'environment',
	'playwright',
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

/**
 * `project_command` ids whose base form writes to the repository. `node_format` runs the package `format`
 * script, which rewrites files in the common case; its read-only form is a variant such as
 * `node_format:check`.
 */
const MUTATING_COMMAND_IDS = new Set(['node_format']);
/**
 * Families that expose at least one repository-writing package script, e.g. `node_lint:fix`. Variants are
 * arbitrary package-script names, so the writing forms cannot be enumerated: every variant of one of these
 * families counts as mutating unless it is a documented read-only form, i.e. an unknown variant fails
 * closed. Base ids keep their own classification above.
 */
const MUTATING_COMMAND_FAMILIES = new Set(['node_format', 'node_lint']);
const MUTATING_COMMAND_VARIANTS = new Set(['fix', 'fixall', 'autofix', 'write', 'apply']);
/** Variants of a mutating family that are known to leave the repository untouched. */
const READ_ONLY_COMMAND_VARIANTS = new Set(['check', 'verify', 'ci']);
/**
 * Commands that write generated output rather than tracked sources: a build writes `dist`, tsbuildinfo,
 * and caches that a sibling's check then reads, so it needs the repository write exclusion without
 * being a source-writing command that the `mutatingCommandRoles` grant refuses.
 */
const ARTIFACT_WRITING_COMMAND_IDS = new Set(['node_build']);
/** Script-name shapes that write generated output, e.g. `node_test:coverage` or `node_test:update-snapshots`. */
const ARTIFACT_WRITING_VARIANT_PATTERNS = [
	/^u$/,
	/^update/,
	/coverage/,
	/snapshot/,
	/codegen/,
	/generate/,
	/write/,
];

function commandIdOf(input: Record<string, unknown> | undefined): string {
	return typeof input?.commandId === 'string' ? input.commandId : '';
}

export function isMutatingCommandId(commandId: string): boolean {
	if (MUTATING_COMMAND_IDS.has(commandId)) return true;
	const [family, ...variants] = commandId.split(':');
	const segments = variants.map((segment) => segment.toLowerCase());
	if (segments.length === 0) return MUTATING_COMMAND_IDS.has(family);
	if (MUTATING_COMMAND_FAMILIES.has(family))
		return !segments.every((segment) => READ_ONLY_COMMAND_VARIANTS.has(segment));
	return segments.some((segment) => MUTATING_COMMAND_VARIANTS.has(segment));
}

/**
 * Whether a command needs exclusive ownership of the repository for its duration. This is wider than
 * {@link isMutatingCommandId}, which decides who is *allowed* to write tracked sources: a build writes
 * generated output a concurrent check would read, and a role may legitimately run it without being a
 * writer. Classification is name-shaped in the same way, so it is a best-effort backstop for the guide
 * rule that generated output belongs to one owner at a time, not a complete account of what a script
 * writes; a project's own test script can write anything at all.
 */
export function isExclusiveWriteCommandId(commandId: string): boolean {
	if (isMutatingCommandId(commandId)) return true;
	const [family, ...variants] = commandId.split(':');
	if (ARTIFACT_WRITING_COMMAND_IDS.has(family)) return true;
	return variants.some((segment) => {
		const variant = segment.toLowerCase();
		return ARTIFACT_WRITING_VARIANT_PATTERNS.some((pattern) => pattern.test(variant));
	});
}

export const BUDGET_STEER_PREFIX = '[herdr budget enforcement]';
export const BUDGET_STEER_MESSAGE = `${BUDGET_STEER_PREFIX} A per-role budget was exhausted. Stop all implementation and validation work. Read the supplied flow ledger or report only if needed, then return the required compact ledger contribution and final report.`;

function noopAbort(): void {}

function emptyBudgetUsage(): BudgetUsage {
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

export function isImplementationTool(name: string): boolean {
	return IMPLEMENTATION_TOOLS.has(name);
}

/** Paths declared in the delegation scope; 0 when the child was launched without one. */
export function declaredScopePathCount(env: NodeJS.ProcessEnv = process.env): number {
	const raw = Number(env[ENV_SCOPE_PATHS]);
	return Number.isInteger(raw) && raw > 0 ? raw : 0;
}

/** Extra inspection calls a declared scope buys on top of the role budget, within the cap. */
export function scopeCallAllowance(
	scopePathCount: number,
	cfg: SubagentHerdrConfig = getConfig(),
): number {
	if (!Number.isFinite(scopePathCount) || scopePathCount <= 0) return 0;
	return Math.min(
		Math.max(0, Math.trunc(cfg.scopeCallAllowancePerPath)) * Math.trunc(scopePathCount),
		Math.max(0, Math.trunc(cfg.scopeCallAllowanceMax)),
	);
}

/**
 * Role limits grown by the allowance for the paths declared in the child's scope. Reviewing N
 * paths costs roughly N inspections, so a flat per-role budget silently caps how large a
 * delegation may be; the allowance keeps the budget proportional without removing the ceiling.
 */
export function scopedRoleBudget(
	role: string,
	scopePathCount: number,
	cfg: SubagentHerdrConfig = getConfig(),
): RoleBudget {
	const limits = roleBudgetFor(role, cfg);
	const allowance = scopeCallAllowance(scopePathCount, cfg);
	if (allowance <= 0) return limits;
	return {
		...limits,
		toolCalls: limits.toolCalls + allowance,
		discoveryCalls: limits.discoveryCalls + allowance,
	};
}

/** The number of total tool calls that must remain available for a worker's finalization path. */
function finalizationReserveCalls(limits: RoleBudget): number {
	const requested = Math.trunc(limits.finalizationReserveCalls ?? 0);
	return Math.max(0, Math.min(requested, Math.max(0, Math.trunc(limits.toolCalls) - 1)));
}

/** The number of validation passes protected for final-state evidence. */
function finalizationReserveValidationPasses(limits: RoleBudget): number {
	const requested = Math.trunc(limits.finalizationReserveValidationPasses ?? 0);
	return Math.max(0, Math.min(requested, Math.max(0, Math.trunc(limits.fullValidationPasses) - 1)));
}

/**
 * A `verify` call that passes a `ref` resolves stored evidence without executing anything, so it is not
 * a validation pass. Every other `verify` call runs the package-script gate, including calls that omit
 * phases.
 */
function verifyResolvesRef(input: Record<string, unknown> | undefined): boolean {
	return typeof input?.ref === 'string' && input.ref.trim().length > 0;
}

/**
 * `verify` parameters a pure lookup may carry. Anything else is treated as changing what executes, what the
 * ref claims, or where evidence is written, so a lookup carrying it counts as execution.
 *
 * This is deliberately an allowlist rather than the blocklist it started as. `verify` gains parameters on the
 * producer's release schedule - a `ref` lookup that names a flow, a `fresh` re-run, a publish target - and a
 * blocklist misclassified each new one as a harmless lookup the moment it shipped, in the one place where a
 * wrong guess lets a read-only seat reach an execution path.
 * `flowId` is admitted because a lookup that names a store reads no working tree; `covers` is an opaque scope
 * list and does not alter the stored evidence. Publication and fresh execution remain execution-capable options.
 */
const VERIFY_LOOKUP_PARAMS: ReadonlySet<string> = new Set(['ref', 'flowId', 'covers']);

/**
 * A pure reference lookup: a non-empty `ref` and nothing that could change what the gate executes.
 * Anything else makes `verify` run package scripts, which is validation execution rather than evidence
 * resolution, so it belongs to the roles named in `validationExecutionRoles`.
 * Keys whose value is `undefined` or `null` are ignored, because a serialized call may carry the whole
 * parameter list; a value that is actually present is what makes a call something other than a lookup.
 */
export function verifyIsRefLookupOnly(input: Record<string, unknown> | undefined): boolean {
	if (!verifyResolvesRef(input)) return false;
	return Object.entries(input ?? {}).every(
		([key, value]) => value === undefined || value === null || VERIFY_LOOKUP_PARAMS.has(key),
	);
}

/**
 * Every `verify` phase accepts an arbitrary package-script name through `scripts`, so an override can point
 * any phase at a repository-writing script: `scripts.format` at the writing formatter, `scripts.lint` at a
 * lint fix, `scripts.test` at a snapshot writer. Which script a phase would run is not knowable from the
 * identifier, so for a role that may not write, the presence of any override is enough to fail closed.
 * The test is deliberately shape-insensitive: a `scripts` value that is not an object is still an override
 * attempt, and a fail-closed rule must not be escapable by argument shape.
 */
export function verifySetsScriptOverrides(input: Record<string, unknown> | undefined): boolean {
	return input?.scripts !== undefined;
}

const MAX_PRODUCER_RESULT_DEPTH = 2;
const MAX_PRODUCER_RESULT_LENGTH = 16_384;
const PRODUCER_RESULT_ENVELOPE_KEYS = [
	'producerResult',
	'producer_result',
	'producerEnvelope',
	'producer_envelope',
	'result',
	'envelope',
] as const;

function producerResultRecords(value: unknown, depth = 0): Record<string, unknown>[] {
	if (depth > MAX_PRODUCER_RESULT_DEPTH) return [];
	if (typeof value === 'string') {
		if (value.length > MAX_PRODUCER_RESULT_LENGTH) return [];
		try {
			return producerResultRecords(JSON.parse(value), depth + 1);
		} catch {
			return [];
		}
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
	const record = value as Record<string, unknown>;
	const records: Record<string, unknown>[] = [];
	if (record.resultCategory === 'RESOLUTION_FAILURE' && record.executed === false)
		records.push(record);
	for (const key of PRODUCER_RESULT_ENVELOPE_KEYS) {
		if (key in record) records.push(...producerResultRecords(record[key], depth + 1));
	}
	return records;
}

/**
 * Whether a validation request was rejected during producer preflight rather than executing a check.
 * Only the structured producer result in tool-result details is authoritative. Tool output is
 * untrusted prose, even when it happens to contain the same marker fields, so `content` is ignored.
 * The explicit envelope and depth/size bounds keep malformed producer details fail-closed.
 */
export function isUnexecutedResolutionFailure(
	details: unknown,
	_content: readonly unknown[] = [],
): boolean {
	return producerResultRecords(details).length > 0;
}

export function classifyToolCall(
	name: string,
	input: Record<string, unknown> | undefined,
): 'discovery' | 'validation' | undefined {
	if (name === 'verify') return verifyIsRefLookupOnly(input) ? undefined : 'validation';
	if (name === 'project_command') {
		const commandId = commandIdOf(input);
		// Variant identifiers such as node_test:coverage or node_format:check run the same family of work
		// as their base command, so they are charged the same way. Keying on the full identifier left a
		// budget escape hatch for every colon-suffixed script.
		const family = commandId.split(':', 1)[0];
		if (VALIDATION_COMMANDS.has(commandId) || VALIDATION_COMMANDS.has(family)) return 'validation';
		if (DISCOVERY_COMMANDS.has(commandId) || DISCOVERY_COMMANDS.has(family)) return 'discovery';
		return undefined;
	}
	return DISCOVERY_TOOLS.has(name) ? 'discovery' : undefined;
}

export function readRequestKey(input: Record<string, unknown>): string | undefined {
	const filePath = typeof input.file_path === 'string' ? input.file_path : input.path;
	if (typeof filePath !== 'string') return undefined;
	return `${filePath}:${String(input.offset ?? '')}:${String(input.limit ?? '')}`;
}

/**
 * Every read request one tool call carries, keyed like {@link readRequestKey}. `read` carries one;
 * `read_batch` may carry several, so its items are charged individually against the repeated-reads
 * metric instead of one multi-path call hiding repeated reads, including duplicates within one call.
 */
export function readRequestKeysOf(name: string, input: Record<string, unknown>): string[] {
	if (name === 'read') {
		const key = readRequestKey(input);
		return key ? [key] : [];
	}
	if (name !== 'read_batch' || !Array.isArray(input.paths)) return [];
	const keys: string[] = [];
	for (const item of input.paths) {
		if (typeof item !== 'object' || item === null) continue;
		const entry = item as { path?: unknown; range?: unknown };
		if (typeof entry.path !== 'string') continue;
		const range =
			typeof entry.range === 'object' && entry.range !== null
				? (entry.range as { offset?: unknown; limit?: unknown })
				: undefined;
		keys.push(`${entry.path}:${String(range?.offset ?? '')}:${String(range?.limit ?? '')}`);
	}
	return keys;
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

/** Usage keys a role budget can limit; `toolArgumentTokens` is recorded but never enforced. */
type LimitedUsageKey = Extract<keyof BudgetUsage, keyof RoleBudget>;

const USAGE_TO_LIMIT: ReadonlyArray<[BudgetMetric, LimitedUsageKey]> = [
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
	implementationStarted = false,
	implementationGateReached = false,
	registryPersists = 0,
	repositoryWriteLockRefusals = 0,
	phase: BudgetPhase = 'discovery',
	cause?: BudgetCause,
	finalizationReady = false,
	finalStateValidation = false,
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
		implementationStarted,
		implementationGateReached,
		registryPersists,
		repositoryWriteLockRefusals,
		phase,
		...(cause ? { cause } : {}),
		finalizationReady,
		finalStateValidation,
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
		existing?.implementationStarted ?? false,
		existing?.implementationGateReached ?? false,
		existing?.registryPersists ?? 0,
		existing?.repositoryWriteLockRefusals ?? 0,
		existing?.phase ?? (breaches.length > 0 ? 'report' : 'discovery'),
		existing?.cause,
		existing?.finalizationReady ?? false,
		existing?.finalStateValidation ?? false,
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
	implementationStarted: boolean;
	implementationGateReached: boolean;
	registryPersists: number;
	repositoryWriteLockRefusals: number;
	phase: BudgetPhase;
	cause?: BudgetCause;
	finalizationReady: boolean;
	finalizationStarted: boolean;
	finalStateValidation: boolean;
}

function currentBreach(
	state: MutableBudgetState,
	skipMetric?: BudgetMetric,
): BudgetBreach | undefined {
	for (const [metric, usageKey] of USAGE_TO_LIMIT) {
		if (metric === skipMetric) continue;
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
		state.implementationStarted,
		state.implementationGateReached,
		state.registryPersists,
		state.repositoryWriteLockRefusals,
		state.phase,
		state.cause,
		state.finalizationReady,
		state.finalStateValidation,
	);
}

function persist(label: string | undefined, state: MutableBudgetState): void {
	if (!label) return;
	state.registryPersists++;
	updateRegistryEntry(label, { budget: summaryOf(state), updatedAt: Date.now() });
}

function addCurrentBreach(
	state: MutableBudgetState,
	skipMetric?: BudgetMetric,
): BudgetBreach | undefined {
	const breach = currentBreach(state, skipMetric);
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
	state.implementationStarted = false;
	state.implementationGateReached = false;
	state.repositoryWriteLockRefusals = 0;
	state.phase = 'discovery';
	state.cause = undefined;
	state.finalizationReady = false;
	state.finalizationStarted = false;
	state.finalStateValidation = false;
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

function causeForMetric(metric: BudgetMetric): BudgetCause {
	switch (metric) {
		case 'discoveryCalls':
			return 'discovery';
		case 'repeatedReads':
			return 'repeated_reads';
		case 'failedToolCalls':
			return 'failed_calls';
		case 'fullValidationPasses':
			return 'validation';
		case 'outputTokens':
			return 'report_output';
		case 'wallTimeMs':
			return 'wall_time';
		default:
			return 'tool_calls';
	}
}

function enforceNewBreach(
	pi: Pick<ExtensionAPI, 'sendUserMessage'>,
	ctx: { abort(): void },
	state: MutableBudgetState,
	beforeSteer?: () => void,
	skipMetric?: BudgetMetric,
): boolean {
	const breach = addCurrentBreach(state, skipMetric);
	if (!breach) return false;
	state.cause ??= causeForMetric(breach.metric);
	if (state.limits.budgetPolicy === 'abort') {
		abortForBudget(ctx, state);
		beforeSteer?.();
	} else {
		const alreadySteered = state.steerIssued;
		steerForBudget(pi, state, beforeSteer);
		if (alreadySteered) beforeSteer?.();
	}
	return true;
}

/**
 * Records a breach first observed on the turn that delivered the report. A turn without tool calls ends
 * the child run, so there is no work left to stop: steering there cannot help and only buys a second,
 * shorter report that replaces the one already written. The breach is kept for telemetry.
 */
function noteReportBreach(state: MutableBudgetState, skipMetric?: BudgetMetric): boolean {
	const breach = addCurrentBreach(state, skipMetric);
	if (!breach) return false;
	state.cause ??= causeForMetric(breach.metric);
	state.phase = 'report';
	if (state.outcome !== 'aborted') {
		state.outcome = 'report_only';
		state.reportOnly = true;
	}
	return true;
}

/**
 * Splits one assistant turn's output into report prose and reasoning. Providers fold reasoning tokens
 * into `usage.output`, so a thinking-heavy model would otherwise spend the report contract on thinking;
 * when a provider does not report the split, the whole turn counts as report prose.
 */
export function splitReportOutput(usage: { output?: number; reasoning?: number } | undefined): {
	report: number;
	reasoning: number;
} {
	const output = Number.isFinite(usage?.output) ? usage!.output! : 0;
	const reasoning =
		Number.isFinite(usage?.reasoning) && usage!.reasoning! > 0
			? Math.min(output, usage!.reasoning!)
			: 0;
	return { report: Math.max(0, output - reasoning), reasoning };
}

function implementationDiscoveryLimit(limits: RoleBudget): number {
	return limits.implementationDiscoveryCalls ?? limits.discoveryCalls;
}

function blocksBeforeImplementation(
	state: MutableBudgetState,
	toolName: string,
	input: Record<string, unknown> | undefined,
	flowId: string | undefined,
): boolean {
	if (state.role !== 'worker' || state.implementationStarted) return false;
	if (state.usage.discoveryCalls <= implementationDiscoveryLimit(state.limits)) return false;
	state.implementationGateReached = true;
	return !isImplementationTool(toolName) && !isReportRead(toolName, input, flowId);
}

/**
 * Names the competing write. An entry that exists but cannot be read is a reason to wait without being
 * a name to quote, so it is reported as an unreadable entry rather than as an unnamed session.
 */
function contentionNote(contention: RepositoryWriteContention, consequence: string): string {
	const holder = contention.holder;
	const since = holder?.acquiredAt ?? contention.observedAt;
	const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
	const who = holder
		? `Session ${holder.label} is writing this repository with ${holder.commandId}`
		: 'A repository lock entry this session cannot identify is holding this repository';
	return `${who} (${seconds}s in flight), so ${consequence}`;
}

export function registerBudgetEnforcement(pi: ExtensionAPI): void {
	if (process.env.PI_SUBAGENT_NESTED !== '1') return;
	const role = process.env.PI_ORCHESTRATION_ROLE;
	if (!role) return;
	const label = process.env.PI_SUBAGENT_LABEL;
	const flowId = process.env[ENV_FLOW];
	const limits = scopedRoleBudget(role, declaredScopePathCount(), getConfig());
	const mutatingRoles = new Set(getConfig().mutatingCommandRoles);
	const validationExecutionRoles = new Set(getConfig().validationExecutionRoles);
	const validationOwners = [...validationExecutionRoles].join(', ') || 'no configured role';
	const writeLockEnabled = getConfig().repositoryWriteLock;
	const lockLabel = label ?? 'unlabeled-session';
	/** Write holds keyed by tool call id, released by the matching tool_result. */
	const heldWrites = new Map<string, RepositoryWriteLockHandle>();
	/** Accepted validation calls whose execution status is resolved by the matching tool result. */
	const pendingValidationCalls = new Map<string, { toolName: string }>();
	/** Final-validation calls wait for their result so a producer preflight failure cannot lock the worker. */
	const pendingFinalizationCalls = new Map<string, { toolName: string }>();
	const state: MutableBudgetState = {
		role,
		limits,
		usage: emptyBudgetUsage(),
		breaches: [],
		outcome: 'within',
		steerIssued: false,
		reportOnly: false,
		automaticSteerPending: false,
		implementationStarted: false,
		implementationGateReached: false,
		registryPersists: 0,
		repositoryWriteLockRefusals: 0,
		phase: 'discovery',
		finalizationReady: false,
		finalizationStarted: false,
		finalStateValidation: false,
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
			const breached = enforceNewBreach(pi, { abort: abortCurrent }, state, () =>
				persist(label, state),
			);
			if (!breached) persist(label, state);
		}, delay);
	};

	/** A call that writes the repository, either by command id or by overriding a `verify` phase. */
	function isWriteCapableCall(
		toolName: string,
		input: Record<string, unknown> | undefined,
		commandId: string,
	): boolean {
		return (
			(commandId !== '' && isExclusiveWriteCommandId(commandId)) ||
			(toolName === 'verify' && verifySetsScriptOverrides(input))
		);
	}

	/**
	 * Repository contention between sibling sessions, in two halves.
	 *
	 * {@link repositoryReadGuard} runs before anything is charged: a check that would read the
	 * repository refuses to start while another session holds it, because evidence gathered over a
	 * half-written tree attests to neither sibling.
	 *
	 * {@link repositoryWriteGuard} runs after every other refusal: a command that writes takes the
	 * repository exclusion for the lifetime of that call, and a call that is about to be refused for a
	 * budget reason must not leave a hold behind, because a refused call never produces the
	 * `tool_result` that releases it.
	 *
	 * A session never blocks on its own hold, identified by label and flow together.
	 */
	function repositoryWriteGuard(
		toolCallId: string | undefined,
		input: Record<string, unknown> | undefined,
		toolName: string,
		commandId: string,
		category: 'discovery' | 'validation' | undefined,
	): ToolCallEventResult | undefined {
		// Release is keyed by tool call id, so a call without one cannot be tracked and must not hold.
		if (!toolCallId) return undefined;
		if (!isWriteCapableCall(toolName, input, commandId)) return undefined;
		// A repeated id means the previous hold was never released; free it before overwriting it.
		releaseWriteHold(toolCallId);
		const acquisition = acquireRepositoryWriteLock({
			label: lockLabel,
			...(flowId ? { flowId } : {}),
			commandId: commandId || 'verify',
		});
		if (acquisition.acquired) {
			heldWrites.set(toolCallId, acquisition.handle);
			return undefined;
		}
		// The command did not run, so it bought no validation pass. The tool call stays charged, which is
		// what bounds the retries the refusal asks for.
		if (category === 'discovery')
			state.usage.discoveryCalls = Math.max(0, state.usage.discoveryCalls - 1);
		if (category === 'validation')
			state.usage.fullValidationPasses = Math.max(0, state.usage.fullValidationPasses - 1);
		state.repositoryWriteLockRefusals++;
		persist(label, state);
		return {
			block: true,
			reason: contentionNote(
				acquisition.contention,
				'a second concurrent write would corrupt the tree. Retry after that command finishes; this refusal costs a tool call, so report the contention if it persists for three attempts.',
			),
		};
	}

	/** Early, side-effect-free half of the contention guard: a check never reads a foreign write. */
	function repositoryReadGuard(
		toolName: string,
		input: Record<string, unknown> | undefined,
		commandId: string,
		category: 'discovery' | 'validation' | undefined,
	): ToolCallEventResult | undefined {
		// A writing command is not a reader with a stale-evidence problem; the write exclusion refuses it.
		if (isWriteCapableCall(toolName, input, commandId)) return undefined;
		const readsRepository =
			toolName === 'verify' ? !verifyIsRefLookupOnly(input) : category === 'validation';
		if (!readsRepository) return undefined;
		const contention = probeRepositoryWriteLock({
			label: lockLabel,
			...(flowId ? { flowId } : {}),
		});
		if (!contention) return undefined;
		state.repositoryWriteLockRefusals++;
		persist(label, state);
		return {
			block: true,
			reason: contentionNote(
				contention,
				'this check would validate a half-written tree. Resolve stored refs instead; if no ref covers the check, retry after that command finishes and report the contention if it persists for three attempts.',
			),
		};
	}

	function releaseWriteHold(toolCallId: string | undefined): void {
		if (!toolCallId) return;
		const handle = heldWrites.get(toolCallId);
		if (!handle) return;
		heldWrites.delete(toolCallId);
		releaseRepositoryWriteLock(handle);
	}

	function releaseAllWriteHolds(): void {
		for (const handle of heldWrites.values()) releaseRepositoryWriteLock(handle);
		heldWrites.clear();
	}

	pi.on('before_agent_start', (event: BeforeAgentStartEvent, ctx) => {
		abortCurrent = ctx.abort;
		if (state.automaticSteerPending && event.prompt.startsWith(BUDGET_STEER_PREFIX)) {
			state.automaticSteerPending = false;
			preserveTurnDeadline = true;
			armWallTimer();
			return;
		}
		const previousOutcome = state.outcome;
		resetTurn(state);
		readKeys.clear();
		pendingValidationCalls.clear();
		pendingFinalizationCalls.clear();
		if (previousOutcome !== state.outcome) persist(label, state);
		preserveTurnDeadline = false;
		turnStartedAt = Date.now();
		armWallTimer();
	});

	pi.on('tool_call', (event: ToolCallEvent, ctx): ToolCallEventResult | undefined => {
		abortCurrent = ctx.abort;
		state.usage.wallTimeMs = Math.max(state.usage.wallTimeMs, Date.now() - turnStartedAt);
		state.usage.toolCalls++;
		const commandId = event.toolName === 'project_command' ? commandIdOf(event.input) : '';
		if (commandId && isMutatingCommandId(commandId) && !mutatingRoles.has(role)) {
			return {
				block: true,
				reason: `Role ${role} may not run the mutating project command ${commandId}. Use its check form (for example node_format:check), the verify gate, or delegate to a role listed in mutatingCommandRoles.`,
			};
		}
		if (event.toolName === 'verify') {
			if (!validationExecutionRoles.has(role) && !verifyIsRefLookupOnly(event.input)) {
				return {
					block: true,
					reason: `Role ${role} may only resolve validation evidence, not execute it: call verify with { ref: 'vr_…' or 'pc_…', flowId?, covers? }, or delegate execution to a role listed in validationExecutionRoles (${validationOwners}).`,
				};
			}
			if (!mutatingRoles.has(role) && verifySetsScriptOverrides(event.input)) {
				return {
					block: true,
					reason: `Role ${role} may not override verify phases: each scripts entry accepts any package script, so an override can reach a writing formatter, a lint fix, or a snapshot writer, and the default phases are the read-only checks. Omit scripts, use the read-only project_command check forms, or delegate to a role listed in mutatingCommandRoles.`,
				};
			}
		}
		const category = classifyToolCall(event.toolName, event.input);
		const implementationCall = isImplementationTool(event.toolName);
		const protectedWriteCall =
			implementationCall ||
			(event.toolName === 'project_command' && isMutatingCommandId(commandId)) ||
			(event.toolName === 'verify' && verifySetsScriptOverrides(event.input));
		const hasImplementation = state.implementationStarted || implementationCall;
		const reserve = role === 'worker' ? finalizationReserveCalls(limits) : 0;
		const reserveThreshold = limits.toolCalls - reserve;
		const executingValidation = category === 'validation' && !verifyIsRefLookupOnly(event.input);
		const finalValidation = event.toolName === 'verify' && executingValidation;
		const reportRead = isReportRead(event.toolName, event.input, flowId);
		const finalizationCall =
			reportRead || event.toolName === 'codegraph_affected' || category === 'validation';
		const startsFinalization =
			role === 'worker' &&
			reserve > 0 &&
			executingValidation &&
			(state.finalizationReady || finalValidation);
		if (role === 'worker' && hasImplementation && reserve > 0) {
			if (state.usage.toolCalls >= reserveThreshold) state.finalizationReady = true;
			if (state.finalizationStarted && protectedWriteCall) {
				state.cause ??= 'finalization_reserve';
				persist(label, state);
				return {
					block: true,
					reason:
						'Worker final validation has started; implementation writes are refused because they would invalidate the final-state evidence. Start a fresh remediation attempt for another edit.',
				};
			}
			if (
				state.finalizationReady &&
				state.usage.toolCalls >= reserveThreshold &&
				!finalizationCall
			) {
				state.cause ??= 'finalization_reserve';
				persist(label, state);
				return {
					block: true,
					reason:
						'Worker finalization reserve reached; complete the affected-test query, final validation, and report, or request a fresh remediation attempt before more discovery.',
				};
			}
			const validationReserve = finalizationReserveValidationPasses(limits);
			if (
				category === 'validation' &&
				!verifyIsRefLookupOnly(event.input) &&
				!state.finalizationStarted &&
				!finalValidation &&
				validationReserve > 0 &&
				state.usage.fullValidationPasses > limits.fullValidationPasses - validationReserve
			) {
				state.cause ??= 'finalization_reserve';
				persist(label, state);
				return {
					block: true,
					reason:
						'Worker final-state validation reserve is protected; finish implementation and enter finalization before spending the reserved validation pass.',
				};
			}
		}
		if (writeLockEnabled) {
			const contended = repositoryReadGuard(event.toolName, event.input, commandId, category);
			if (contended) return contended;
		}
		if (category === 'discovery') state.usage.discoveryCalls++;
		if (category === 'validation') state.usage.fullValidationPasses++;
		if (event.toolName === 'read' || event.toolName === 'read_batch') {
			for (const key of readRequestKeysOf(event.toolName, event.input)) {
				const prior = readKeys.get(key) ?? 0;
				if (prior > 0) state.usage.repeatedReads++;
				readKeys.set(key, prior + 1);
			}
		}
		const breached = enforceNewBreach(
			pi,
			ctx,
			state,
			() => persist(label, state),
			pendingValidationCalls.size > 0 || executingValidation ? 'fullValidationPasses' : undefined,
		);
		if (state.outcome === 'aborted')
			return {
				block: true,
				reason: `Budget exhausted for role ${role}: ${state.breaches.at(-1)?.metric}`,
			};
		if (state.reportOnly && !reportRead) {
			const nextOutcome = breached ? 'steered' : 'report_only';
			if (state.outcome !== nextOutcome) {
				state.outcome = nextOutcome;
				persist(label, state);
			}
			return {
				block: true,
				reason: `Budget exhausted for role ${role}; only ledger/report reads are allowed`,
			};
		}
		if (breached && !reportRead) {
			return {
				block: true,
				reason: `Budget exhausted for role ${role}: ${state.breaches.at(-1)?.metric}`,
			};
		}
		const gateWasReached = state.implementationGateReached;
		if (blocksBeforeImplementation(state, event.toolName, event.input, flowId)) {
			if (!gateWasReached) persist(label, state);
			return {
				block: true,
				reason: `Worker must make an implementation change before more discovery; only implementation tools and ledger/report reads are allowed`,
			};
		}
		if (writeLockEnabled) {
			const contended = repositoryWriteGuard(
				event.toolCallId,
				event.input,
				event.toolName,
				commandId,
				category,
			);
			if (contended) return contended;
		}
		if (implementationCall && !state.implementationStarted) {
			state.implementationStarted = true;
			state.phase = 'implementation';
			persist(label, state);
		}
		const executesValidation = category === 'validation' && !verifyIsRefLookupOnly(event.input);
		// Calls without an identity remain charged, but cannot settle preflight status or finalization.
		if (executesValidation && event.toolCallId)
			pendingValidationCalls.set(event.toolCallId, { toolName: event.toolName });
		if (startsFinalization && event.toolCallId)
			pendingFinalizationCalls.set(event.toolCallId, { toolName: event.toolName });
		return undefined;
	});

	pi.on('tool_result', (event: ToolResultEvent, ctx) => {
		abortCurrent = ctx.abort;
		if (writeLockEnabled) releaseWriteHold(event.toolCallId);
		if (event.isError) state.usage.failedToolCalls++;
		const pendingValidation = pendingValidationCalls.get(event.toolCallId);
		const pendingFinalization = pendingFinalizationCalls.get(event.toolCallId);
		const validationWasPending = pendingValidation?.toolName === event.toolName;
		const finalizationWasPending = pendingFinalization?.toolName === event.toolName;
		if (validationWasPending) pendingValidationCalls.delete(event.toolCallId);
		if (finalizationWasPending) pendingFinalizationCalls.delete(event.toolCallId);
		const preflightFailure =
			(validationWasPending || finalizationWasPending) &&
			isUnexecutedResolutionFailure(event.details, event.content);
		let stateChanged = false;
		if (validationWasPending && preflightFailure) {
			// The call itself remains charged, as does the producer error, but no package-script
			// validation pass was executed.
			state.usage.fullValidationPasses = Math.max(0, state.usage.fullValidationPasses - 1);
			stateChanged = true;
		}
		if (finalizationWasPending && !preflightFailure) {
			state.finalizationStarted = true;
			state.phase = 'finalization';
			state.finalStateValidation = true;
			stateChanged = true;
		}
		const breached = enforceNewBreach(
			pi,
			ctx,
			state,
			() => persist(label, state),
			pendingValidationCalls.size > 0 ? 'fullValidationPasses' : undefined,
		);
		if (stateChanged && !breached) persist(label, state);
	});

	pi.on('turn_end', (event: TurnEndEvent, ctx) => {
		abortCurrent = ctx.abort;
		let deliveredReport = false;
		if (event.message.role === 'assistant') {
			deliveredReport = !event.message.content.some((part) => part.type === 'toolCall');
			if (deliveredReport) {
				// This turn is the report itself, so only its prose is charged against the output budget.
				const share = splitReportOutput(event.message.usage);
				state.usage.outputTokens += share.report;
				if (share.reasoning > 0)
					state.usage.reasoningTokens = (state.usage.reasoningTokens ?? 0) + share.reasoning;
			} else {
				// Turns that issue tool calls spend their output on arguments, which the call budgets
				// already bound.
				state.usage.toolArgumentTokens =
					(state.usage.toolArgumentTokens ?? 0) + (event.message.usage?.output ?? 0);
			}
		}
		state.usage.wallTimeMs = Math.max(state.usage.wallTimeMs, Date.now() - turnStartedAt);
		if (deliveredReport) {
			state.phase = 'report';
			noteReportBreach(state, pendingValidationCalls.size > 0 ? 'fullValidationPasses' : undefined);
			persist(label, state);
			return;
		}
		enforceNewBreach(
			pi,
			ctx,
			state,
			() => persist(label, state),
			pendingValidationCalls.size > 0 ? 'fullValidationPasses' : undefined,
		);
		persist(label, state);
	});

	pi.on('agent_end', () => {
		releaseAllWriteHolds();
		clearWallTimer();
	});
	pi.on('agent_settled', () => {
		releaseAllWriteHolds();
		clearWallTimer();
		persist(label, state);
	});

	pi.on('turn_start', () => {
		if (!preserveTurnDeadline) turnStartedAt = Date.now();
		preserveTurnDeadline = false;
		armWallTimer();
	});
}
