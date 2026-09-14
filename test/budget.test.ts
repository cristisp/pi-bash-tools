import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configPath, DEFAULT_CONFIG, roleBudgetFor } from '../src/config.ts';
import {
	BUDGET_STEER_PREFIX,
	classifyToolCall,
	declaredScopePathCount,
	isImplementationTool,
	isMutatingCommandId,
	isExclusiveWriteCommandId,
	isReportRead,
	readRequestKey,
	registerBudgetEnforcement,
	scopeCallAllowance,
	scopedRoleBudget,
} from '../src/budget.ts';
import { findEntry, registerEntry } from '../src/registry.ts';
import {
	acquireRepositoryWriteLock,
	probeRepositoryWriteLock,
	releaseRepositoryWriteLock,
	repositoryWriteLockPath,
} from '../src/repo-lock.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { assistantMsg, makeRegistryEntry, makeTempDir, stubEnv } from './helpers.ts';

type Handler = (event: any, ctx: any) => unknown;

function fakePi(): {
	pi: ExtensionAPI;
	handlers: Record<string, Handler>;
	sendUserMessage: ReturnType<typeof vi.fn>;
} {
	const handlers: Record<string, Handler> = {};
	const sendUserMessage = vi.fn();
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers[event] = handler;
		},
		sendUserMessage,
	} as unknown as ExtensionAPI;
	return { pi, handlers, sendUserMessage };
}

function settleBudget(handlers: Record<string, Handler>, ctx: { abort(): void }): void {
	handlers.agent_settled?.({}, ctx);
}

describe('budget classification', () => {
	it('classifies discovery, validation, and ordinary calls', () => {
		expect(classifyToolCall('read', { path: 'src/index.ts' })).toBe('discovery');
		expect(classifyToolCall('codegraph_artifact', { ref: 'cg_abc' })).toBe('discovery');
		expect(classifyToolCall('project_command', { commandId: 'node_test' })).toBe('validation');
		expect(classifyToolCall('project_command', { commandId: 'node_project_info' })).toBe(
			'discovery',
		);
		expect(classifyToolCall('edit', { path: 'src/index.ts' })).toBeUndefined();
		expect(classifyToolCall('verify', {})).toBe('validation');
		expect(classifyToolCall('verify', { omit: ['format'] })).toBe('validation');
		expect(classifyToolCall('verify', { ref: '  ' })).toBe('validation');
		expect(classifyToolCall('verify', { ref: 'vr_abc' })).toBeUndefined();
		expect(
			classifyToolCall('verify', { ref: 'vr_abc', flowId: 'f1', covers: ['AC-001'] }),
		).toBeUndefined();
		expect(classifyToolCall('verify', { ref: 'vr_abc', fresh: true })).toBe('validation');
		expect(isImplementationTool('edit')).toBe(true);
		expect(isImplementationTool('read')).toBe(false);
	});

	it('charges a variant command id to its family and fails closed on families that can write', () => {
		// The escape hatch: a colon-suffixed package script runs the same family of work as the base id,
		// so it is charged the same way instead of dodging the validation counter.
		expect(classifyToolCall('project_command', { commandId: 'node_test:coverage' })).toBe(
			'validation',
		);
		expect(classifyToolCall('project_command', { commandId: 'node_lint:ci' })).toBe('validation');
		expect(classifyToolCall('project_command', { commandId: 'node_format:check' })).toBe(
			'validation',
		);
		// Writing forms of a family that can write, whether the variant is named or not.
		expect(isMutatingCommandId('node_format')).toBe(true);
		expect(isMutatingCommandId('node_format:write')).toBe(true);
		expect(isMutatingCommandId('node_lint:fix')).toBe(true);
		expect(isMutatingCommandId('node_lint:coverage')).toBe(true);
		expect(isMutatingCommandId('node_lint:update')).toBe(true);
		// The documented read-only forms of those families stay available to every role, and the read-only
		// base of a family whose writes live only in its variants stays read-only.
		expect(isMutatingCommandId('node_format:check')).toBe(false);
		expect(isMutatingCommandId('node_lint:check')).toBe(false);
		expect(isMutatingCommandId('node_lint:verify')).toBe(false);
		expect(isMutatingCommandId('node_format:CI')).toBe(false);
		expect(isMutatingCommandId('node_lint')).toBe(false);
		// A family with no writing form is classified by the known writing variants only.
		expect(isMutatingCommandId('node_test:coverage')).toBe(false);
		expect(isMutatingCommandId('node_test:snapshot-upload')).toBe(false);
		expect(isMutatingCommandId('fallow_dupes:whatever')).toBe(false);
		// Discovery families keep charging variants, or discovery would look like free tool use.
		expect(
			classifyToolCall('project_command', { commandId: 'fallow_list_boundaries:verbose' }),
		).toBe('discovery');
		expect(classifyToolCall('project_command', { commandId: 'node_project_info:verbose' })).toBe(
			'discovery',
		);
		expect(classifyToolCall('project_command', { commandId: 'node_deps_list:unknown_thing' })).toBe(
			'discovery',
		);
	});

	it('recognizes report reads and distinguishes read requests', () => {
		expect(isReportRead('read', { path: '/tmp/flows/f1/ledger.md' })).toBe(false);
		expect(isReportRead('read', { path: '/tmp/flows/f1/reports/worker.md' })).toBe(false);
		expect(isReportRead('read', { path: '/tmp/flows/f1/reports/worker.md' }, 'f1')).toBe(true);
		expect(isReportRead('read', { path: '/tmp/flows/f1/reports/worker.md' }, 'f2')).toBe(false);
		expect(isReportRead('read', { path: '/tmp/src/ledger.md' })).toBe(false);
		expect(readRequestKey({ path: 'src/a.ts', offset: 1, limit: 2 })).toBe('src/a.ts:1:2');
	});
});

describe('scope-scaled inspection budgets', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('adds a bounded allowance for every declared in-scope path', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		const perPath = DEFAULT_CONFIG.scopeCallAllowancePerPath;
		expect(scopeCallAllowance(0)).toBe(0);
		expect(scopeCallAllowance(10)).toBe(10 * perPath);
		expect(scopeCallAllowance(10_000)).toBe(DEFAULT_CONFIG.scopeCallAllowanceMax);
		const base = roleBudgetFor('reviewer');
		const scoped = scopedRoleBudget('reviewer', 10);
		expect(scoped.toolCalls).toBe(base.toolCalls + 10 * perPath);
		expect(scoped.discoveryCalls).toBe(base.discoveryCalls + 10 * perPath);
		expect(scoped.outputTokens).toBe(base.outputTokens);
		expect(scopedRoleBudget('reviewer', 0)).toEqual(base);
	});

	it('reads the declared path count from the child environment', () => {
		expect(declaredScopePathCount({})).toBe(0);
		expect(declaredScopePathCount({ PI_ORCHESTRATION_SCOPE_PATHS: '7' })).toBe(7);
		expect(declaredScopePathCount({ PI_ORCHESTRATION_SCOPE_PATHS: 'nope' })).toBe(0);
		expect(declaredScopePathCount({ PI_ORCHESTRATION_SCOPE_PATHS: '-3' })).toBe(0);
		expect(declaredScopePathCount({ PI_ORCHESTRATION_SCOPE_PATHS: '1.5' })).toBe(0);
	});
});

describe('live budget enforcement', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('persists live budget state at transitions instead of every tool call', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		vi.stubEnv('PI_SUBAGENT_NESTED', '1');
		vi.stubEnv('PI_ORCHESTRATION_ROLE', 'worker');
		vi.stubEnv('PI_SUBAGENT_LABEL', 'worker-persist');
		registerEntry(makeRegistryEntry({ label: 'worker-persist' }));
		const { pi, handlers } = fakePi();
		registerBudgetEnforcement(pi);
		const ctx = { abort: vi.fn() };

		handlers.before_agent_start?.({ prompt: 'implement this' }, ctx);
		handlers.tool_call?.({ toolName: 'read', input: { path: 'src/a.ts' } }, ctx);
		expect(findEntry('worker-persist')?.budget).toBeUndefined();
		handlers.tool_call?.({ toolName: 'edit', input: { path: 'src/a.ts' } }, ctx);
		expect(findEntry('worker-persist')?.budget?.registryPersists).toBe(1);
		handlers.tool_call?.({ toolName: 'read', input: { path: 'src/b.ts' } }, ctx);
		expect(findEntry('worker-persist')?.budget?.registryPersists).toBe(1);
		handlers.turn_end?.({ message: assistantMsg('done') }, ctx);
		expect(findEntry('worker-persist')?.budget?.registryPersists).toBe(2);
		handlers.agent_end?.({}, ctx);
	});

	it('does not register on a root session', () => {
		vi.stubEnv('PI_ORCHESTRATION_ROLE', 'worker');
		const { pi, handlers } = fakePi();
		registerBudgetEnforcement(pi);
		expect(Object.keys(handlers)).toEqual([]);
	});

	it('steers once, blocks non-report tools, and persists the breach', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		vi.stubEnv('PI_SUBAGENT_NESTED', '1');
		fs.writeFileSync(configPath(), JSON.stringify({ roleBudgets: { worker: { toolCalls: 1 } } }));
		vi.stubEnv('PI_ORCHESTRATION_ROLE', 'worker');
		vi.stubEnv('PI_ORCHESTRATION_FLOW', 'f1');
		vi.stubEnv('PI_SUBAGENT_LABEL', 'worker-1');
		registerEntry(makeRegistryEntry({ label: 'worker-1' }));
		const { pi, handlers, sendUserMessage } = fakePi();
		registerBudgetEnforcement(pi);
		handlers.before_agent_start?.({ prompt: 'Task: implement this' }, { abort: vi.fn() });
		const ctx = { abort: vi.fn() };
		const first = handlers.tool_call?.({ toolName: 'bash', input: { command: 'true' } }, ctx);
		const second = handlers.tool_call?.({ toolName: 'bash', input: { command: 'true' } }, ctx);
		const report = handlers.tool_call?.(
			{ toolName: 'read', input: { path: '/tmp/flows/f1/reports/worker.md' } },
			ctx,
		);
		const third = handlers.tool_call?.({ toolName: 'bash', input: { command: 'true' } }, ctx);

		expect(first).toBeUndefined();
		expect(second).toMatchObject({ block: true });
		expect(report).toBeUndefined();
		expect(third).toMatchObject({ block: true });
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		expect(sendUserMessage.mock.calls[0]?.[0]).toContain(BUDGET_STEER_PREFIX);
		expect(findEntry('worker-1')?.budget).toMatchObject({
			outcome: 'report_only',
			steerIssued: true,
			reportOnly: true,
		});
		handlers.agent_end?.({}, { abort: vi.fn() });
	});

	it('charges an executing verify to the validation budget and spares ref lookups', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		vi.stubEnv('PI_SUBAGENT_NESTED', '1');
		fs.writeFileSync(
			configPath(),
			JSON.stringify({ roleBudgets: { validator: { fullValidationPasses: 1 } } }),
		);
		// The validator owns execution, so this exercises charging rather than the lookup-only rule for
		// roles outside validationExecutionRoles, which has its own test below.
		vi.stubEnv('PI_ORCHESTRATION_ROLE', 'validator');
		vi.stubEnv('PI_SUBAGENT_LABEL', 'validator-1');
		registerEntry(makeRegistryEntry({ label: 'validator-1' }));
		const { pi, handlers, sendUserMessage } = fakePi();
		registerBudgetEnforcement(pi);
		const ctx = { abort: vi.fn() };

		handlers.before_agent_start?.({ prompt: 'validate this' }, ctx);
		const executed = handlers.tool_call?.({ toolName: 'verify', input: {} }, ctx);
		const lookup = handlers.tool_call?.({ toolName: 'verify', input: { ref: 'vr_aaa' } }, ctx);
		const rerun = handlers.tool_call?.({ toolName: 'verify', input: {} }, ctx);

		expect(executed).toBeUndefined();
		expect(lookup).toBeUndefined();
		expect(rerun).toMatchObject({ block: true });
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		expect(findEntry('validator-1')?.budget).toMatchObject({
			usage: { toolCalls: 3, fullValidationPasses: 2 },
			breaches: [{ metric: 'fullValidationPasses', limit: 1, observed: 2 }],
			steerIssued: true,
		});
		handlers.agent_end?.({}, { abort: vi.fn() });
	});

	it('blocks mutating project commands for roles that do not own repository changes', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		vi.stubEnv('PI_SUBAGENT_NESTED', '1');
		vi.stubEnv('PI_ORCHESTRATION_ROLE', 'validator');
		vi.stubEnv('PI_SUBAGENT_LABEL', 'validator-1');
		registerEntry(makeRegistryEntry({ label: 'validator-1' }));
		const { pi, handlers, sendUserMessage } = fakePi();
		registerBudgetEnforcement(pi);
		const ctx = { abort: vi.fn() };

		handlers.before_agent_start?.({ prompt: 'validate this' }, ctx);
		const format = handlers.tool_call?.(
			{ toolName: 'project_command', input: { commandId: 'node_format' } },
			ctx,
		);
		const lintFix = handlers.tool_call?.(
			{ toolName: 'project_command', input: { commandId: 'node_lint:fix' } },
			ctx,
		);
		const formatCheck = handlers.tool_call?.(
			{ toolName: 'project_command', input: { commandId: 'node_format:check' } },
			ctx,
		);

		expect(format).toMatchObject({ block: true });
		expect((format as { reason: string }).reason).toContain('node_format:check');
		expect(lintFix).toMatchObject({ block: true });
		expect(formatCheck).toBeUndefined();
		expect(sendUserMessage).not.toHaveBeenCalled();
		settleBudget(handlers, ctx);
		expect(findEntry('validator-1')?.budget).toMatchObject({
			usage: { toolCalls: 3, fullValidationPasses: 1 },
			breaches: [],
		});
		handlers.agent_end?.({}, { abort: vi.fn() });
	});

	it('lets a role named in mutatingCommandRoles run the mutating command', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		vi.stubEnv('PI_SUBAGENT_NESTED', '1');
		fs.writeFileSync(
			configPath(),
			JSON.stringify({ roleBudgets: { worker: { fullValidationPasses: 4 } } }),
		);
		vi.stubEnv('PI_ORCHESTRATION_ROLE', 'worker');
		vi.stubEnv('PI_SUBAGENT_LABEL', 'worker-1');
		registerEntry(makeRegistryEntry({ label: 'worker-1' }));
		const { pi, handlers } = fakePi();
		registerBudgetEnforcement(pi);
		const ctx = { abort: vi.fn() };

		handlers.before_agent_start?.({ prompt: 'implement this' }, ctx);
		const mutate = handlers.tool_call?.(
			{ toolName: 'project_command', input: { commandId: 'node_format' } },
			ctx,
		);

		expect(mutate).toBeUndefined();
		settleBudget(handlers, ctx);
		expect(findEntry('worker-1')?.budget).toMatchObject({
			usage: { toolCalls: 1, fullValidationPasses: 1 },
		});
		handlers.agent_end?.({}, { abort: vi.fn() });
	});

	it('restricts verify to ref lookups for roles outside validationExecutionRoles', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		vi.stubEnv('PI_SUBAGENT_NESTED', '1');
		vi.stubEnv('PI_ORCHESTRATION_ROLE', 'reviewer');
		vi.stubEnv('PI_SUBAGENT_LABEL', 'reviewer-1');
		registerEntry(makeRegistryEntry({ label: 'reviewer-1' }));
		const { pi, handlers, sendUserMessage } = fakePi();
		registerBudgetEnforcement(pi);
		const ctx = { abort: vi.fn() };

		const verifyCall = (input: Record<string, unknown>) =>
			handlers.tool_call?.({ toolName: 'verify', input }, ctx);

		handlers.before_agent_start?.({ prompt: 'review this' }, ctx);
		const lookup = verifyCall({ ref: 'vr_x' });
		const execute = verifyCall({});
		const covers = verifyCall({ covers: ['AC-001'] });
		// A ref does not license execution: any parameter that changes what runs is refused.
		const refPlusPaths = verifyCall({ ref: 'vr_x', paths: ['src/budget.ts'] });
		const refPlusOmit = verifyCall({ ref: 'vr_x', omit: ['format'] });

		expect(lookup).toBeUndefined();
		expect(execute).toMatchObject({ block: true });
		expect((execute as { reason: string }).reason).toContain('validationExecutionRoles');
		expect((execute as { reason: string }).reason).toContain('worker, validator');
		expect(covers).toMatchObject({ block: true });
		expect(refPlusPaths).toMatchObject({ block: true });
		expect(refPlusOmit).toMatchObject({ block: true });
		// Resolving evidence is not a validation pass, and a refused call must not charge one either.
		settleBudget(handlers, ctx);
		expect(findEntry('reviewer-1')?.budget).toMatchObject({
			usage: { toolCalls: 5, fullValidationPasses: 0 },
			breaches: [],
		});
		expect(sendUserMessage).not.toHaveBeenCalled();
		handlers.agent_end?.({}, { abort: vi.fn() });
	});

	it('treats any parameter outside the lookup allowlist as execution, including unknown ones', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		vi.stubEnv('PI_SUBAGENT_NESTED', '1');
		vi.stubEnv('PI_ORCHESTRATION_ROLE', 'reviewer');
		vi.stubEnv('PI_SUBAGENT_LABEL', 'reviewer-1');
		registerEntry(makeRegistryEntry({ label: 'reviewer-1' }));
		const { pi, handlers } = fakePi();
		registerBudgetEnforcement(pi);
		const ctx = { abort: vi.fn() };
		handlers.before_agent_start?.({ prompt: 'review this' }, ctx);
		const verifyCall = (input: Record<string, unknown>) =>
			handlers.tool_call?.({ toolName: 'verify', input }, ctx);

		expect(verifyCall({ ref: 'vr_x', flowId: 'flow-1' })).toBeUndefined();
		expect(verifyCall({ ref: 'vr_x', omit: undefined })).toBeUndefined();
		expect(verifyCall({ ref: 'vr_x', publish: { flowId: 'flow-1' } })).toMatchObject({
			block: true,
		});
		expect(verifyCall({ ref: 'vr_x', fresh: true })).toMatchObject({ block: true });
		expect(verifyCall({ ref: 'vr_x', someFutureParameter: true })).toMatchObject({ block: true });
		handlers.agent_end?.({}, { abort: vi.fn() });
	});

	it('blocks verify script-phase overrides for roles outside mutatingCommandRoles', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		vi.stubEnv('PI_SUBAGENT_NESTED', '1');
		vi.stubEnv('PI_ORCHESTRATION_ROLE', 'validator');
		vi.stubEnv('PI_SUBAGENT_LABEL', 'validator-1');
		registerEntry(makeRegistryEntry({ label: 'validator-1' }));
		const { pi, handlers, sendUserMessage } = fakePi();
		registerBudgetEnforcement(pi);
		const ctx = { abort: vi.fn() };

		handlers.before_agent_start?.({ prompt: 'validate this' }, ctx);
		// Every phase accepts an arbitrary package script, so none of them is overridable here: format can
		// name the writing formatter, lint a fix, test a snapshot writer.
		const formatOverride = { scripts: { format: 'format' } };
		const lintOverride = { scripts: { lint: 'lint:fix' } };
		const arrayOverride = { scripts: ['format'] };
		const stringOverride = { scripts: 'format:write' };
		const override = handlers.tool_call?.({ toolName: 'verify', input: formatOverride }, ctx);
		const lint = handlers.tool_call?.({ toolName: 'verify', input: lintOverride }, ctx);
		const asArray = handlers.tool_call?.({ toolName: 'verify', input: arrayOverride }, ctx);
		const asString = handlers.tool_call?.({ toolName: 'verify', input: stringOverride }, ctx);
		const remainder = handlers.tool_call?.(
			{ toolName: 'verify', input: { paths: ['src/budget.ts'] } },
			ctx,
		);
		const resolved = handlers.tool_call?.({ toolName: 'verify', input: { ref: 'vr_x' } }, ctx);

		expect(override).toMatchObject({ block: true });
		expect(lint).toMatchObject({ block: true });
		// Fail closed regardless of argument shape, so the rule is not escapable by serialization.
		expect(asArray).toMatchObject({ block: true });
		expect(asString).toMatchObject({ block: true });
		expect((override as { reason: string }).reason).toContain('any package script');
		expect((override as { reason: string }).reason).toContain('read-only');
		expect((override as { reason: string }).reason).toContain('mutatingCommandRoles');
		// An execution role still owns the read-only gate and every ref lookup.
		expect(remainder).toBeUndefined();
		expect(resolved).toBeUndefined();
		settleBudget(handlers, ctx);
		expect(findEntry('validator-1')?.budget).toMatchObject({
			usage: { toolCalls: 6, fullValidationPasses: 1 },
			breaches: [],
		});
		expect(sendUserMessage).not.toHaveBeenCalled();
		handlers.agent_end?.({}, { abort: vi.fn() });
	});

	it('lets a role named in mutatingCommandRoles override a verify phase', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		vi.stubEnv('PI_SUBAGENT_NESTED', '1');
		vi.stubEnv('PI_ORCHESTRATION_ROLE', 'worker');
		vi.stubEnv('PI_SUBAGENT_LABEL', 'worker-1');
		registerEntry(makeRegistryEntry({ label: 'worker-1' }));
		const { pi, handlers } = fakePi();
		registerBudgetEnforcement(pi);
		const ctx = { abort: vi.fn() };

		handlers.before_agent_start?.({ prompt: 'implement this' }, ctx);
		const override = handlers.tool_call?.(
			{ toolName: 'verify', input: { scripts: { lint: 'lint:fix' } } },
			ctx,
		);

		expect(override).toBeUndefined();
		settleBudget(handlers, ctx);
		expect(findEntry('worker-1')?.budget).toMatchObject({
			usage: { toolCalls: 1, fullValidationPasses: 1 },
		});
		handlers.agent_end?.({}, { abort: vi.fn() });
	});

	it('requires implementation before allowing further worker discovery', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		vi.stubEnv('PI_SUBAGENT_NESTED', '1');
		fs.writeFileSync(
			configPath(),
			JSON.stringify({
				roleBudgets: { worker: { implementationDiscoveryCalls: 2, discoveryCalls: 8 } },
			}),
		);
		vi.stubEnv('PI_ORCHESTRATION_ROLE', 'worker');
		vi.stubEnv('PI_ORCHESTRATION_FLOW', 'f1');
		vi.stubEnv('PI_SUBAGENT_LABEL', 'worker-1');
		registerEntry(makeRegistryEntry({ label: 'worker-1' }));
		const { pi, handlers, sendUserMessage } = fakePi();
		registerBudgetEnforcement(pi);
		const ctx = { abort: vi.fn() };

		handlers.before_agent_start?.({ prompt: 'implement this' }, ctx);
		expect(
			handlers.tool_call?.({ toolName: 'read', input: { path: 'src/a.ts' } }, ctx),
		).toBeUndefined();
		expect(
			handlers.tool_call?.({ toolName: 'read', input: { path: 'src/b.ts' } }, ctx),
		).toBeUndefined();
		const blocked = handlers.tool_call?.({ toolName: 'read', input: { path: 'src/c.ts' } }, ctx);
		const unrelated = handlers.tool_call?.(
			{ toolName: 'project_command', input: { commandId: 'node_test' } },
			ctx,
		);

		expect(blocked).toMatchObject({ block: true });
		expect(unrelated).toMatchObject({ block: true });
		expect(sendUserMessage).not.toHaveBeenCalled();
		settleBudget(handlers, ctx);
		expect(findEntry('worker-1')?.budget).toMatchObject({
			outcome: 'within',
			breaches: [],
			implementationStarted: false,
			implementationGateReached: true,
		});

		expect(
			handlers.tool_call?.({ toolName: 'edit', input: { path: 'src/a.ts' } }, ctx),
		).toBeUndefined();
		expect(findEntry('worker-1')?.budget).toMatchObject({
			implementationStarted: true,
			implementationGateReached: true,
		});
		expect(
			handlers.tool_call?.({ toolName: 'read', input: { path: 'src/d.ts' } }, ctx),
		).toBeUndefined();
		handlers.agent_end?.({}, ctx);
	});

	it('resets live usage, steering, and implementation phase at the start of a reuse turn', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		vi.stubEnv('PI_SUBAGENT_NESTED', '1');
		fs.writeFileSync(configPath(), JSON.stringify({ roleBudgets: { worker: { toolCalls: 1 } } }));
		vi.stubEnv('PI_ORCHESTRATION_ROLE', 'worker');
		vi.stubEnv('PI_ORCHESTRATION_FLOW', 'f1');
		vi.stubEnv('PI_SUBAGENT_LABEL', 'worker-1');
		registerEntry(makeRegistryEntry({ label: 'worker-1' }));
		const { pi, handlers, sendUserMessage } = fakePi();
		registerBudgetEnforcement(pi);
		const ctx = { abort: vi.fn() };

		handlers.before_agent_start?.({ prompt: 'first turn' }, ctx);
		handlers.tool_call?.({ toolName: 'bash', input: {} }, ctx);
		handlers.tool_call?.({ toolName: 'bash', input: {} }, ctx);
		expect(findEntry('worker-1')?.budget?.outcome).toBe('steered');

		handlers.before_agent_start?.({ prompt: 'reuse turn' }, ctx);
		expect(findEntry('worker-1')?.budget).toMatchObject({
			outcome: 'within',
			steerIssued: false,
			usage: { toolCalls: 0 },
			implementationStarted: false,
			implementationGateReached: false,
		});
		expect(handlers.tool_call?.({ toolName: 'bash', input: {} }, ctx)).toBeUndefined();
		expect(sendUserMessage).toHaveBeenCalledOnce();
		handlers.agent_end?.({}, ctx);
	});

	it('enforces a wall-time breach while no tool event is occurring', () => {
		vi.useFakeTimers();
		try {
			const dir = makeTempDir();
			stubEnv(dir);
			vi.stubEnv('PI_SUBAGENT_NESTED', '1');
			fs.writeFileSync(
				configPath(),
				JSON.stringify({ roleBudgets: { worker: { wallTimeMs: 5, budgetPolicy: 'abort' } } }),
			);
			vi.stubEnv('PI_ORCHESTRATION_ROLE', 'worker');
			vi.stubEnv('PI_ORCHESTRATION_FLOW', 'f1');
			vi.stubEnv('PI_SUBAGENT_LABEL', 'worker-1');
			registerEntry(makeRegistryEntry({ label: 'worker-1' }));
			const { pi, handlers } = fakePi();
			registerBudgetEnforcement(pi);
			const ctx = { abort: vi.fn() };

			handlers.before_agent_start?.({ prompt: 'slow turn' }, ctx);
			vi.advanceTimersByTime(10);

			expect(ctx.abort).toHaveBeenCalledOnce();
			expect(findEntry('worker-1')?.budget).toMatchObject({
				outcome: 'aborted',
				breaches: [{ metric: 'wallTimeMs' }],
			});
			handlers.agent_end?.({}, ctx);
		} finally {
			vi.useRealTimers();
		}
	});

	it('preserves the wall-time deadline across an automatic steer', () => {
		vi.useFakeTimers();
		try {
			const dir = makeTempDir();
			stubEnv(dir);
			vi.stubEnv('PI_SUBAGENT_NESTED', '1');
			fs.writeFileSync(
				configPath(),
				JSON.stringify({ roleBudgets: { worker: { toolCalls: 1, wallTimeMs: 10 } } }),
			);
			vi.stubEnv('PI_ORCHESTRATION_ROLE', 'worker');
			vi.stubEnv('PI_ORCHESTRATION_FLOW', 'f1');
			vi.stubEnv('PI_SUBAGENT_LABEL', 'worker-1');
			registerEntry(makeRegistryEntry({ label: 'worker-1' }));
			const { pi, handlers, sendUserMessage } = fakePi();
			registerBudgetEnforcement(pi);
			const ctx = { abort: vi.fn() };

			handlers.before_agent_start?.({ prompt: 'first turn' }, ctx);
			vi.advanceTimersByTime(5);
			handlers.tool_call?.({ toolName: 'bash', input: {} }, ctx);
			handlers.tool_call?.({ toolName: 'bash', input: {} }, ctx);
			handlers.before_agent_start?.({ prompt: `${BUDGET_STEER_PREFIX} finish report` }, ctx);
			handlers.turn_start?.({}, ctx);
			vi.advanceTimersByTime(6);

			expect(sendUserMessage).toHaveBeenCalledOnce();
			expect(findEntry('worker-1')?.budget?.breaches).toEqual(
				expect.arrayContaining([expect.objectContaining({ metric: 'wallTimeMs' })]),
			);
			handlers.agent_end?.({}, ctx);
		} finally {
			vi.useRealTimers();
		}
	});

	it('aborts instead of steering when the role policy is abort', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		vi.stubEnv('PI_SUBAGENT_NESTED', '1');
		fs.writeFileSync(
			configPath(),
			JSON.stringify({ roleBudgets: { worker: { toolCalls: 1, budgetPolicy: 'abort' } } }),
		);
		vi.stubEnv('PI_ORCHESTRATION_ROLE', 'worker');
		vi.stubEnv('PI_ORCHESTRATION_FLOW', 'f1');
		vi.stubEnv('PI_SUBAGENT_LABEL', 'worker-1');
		registerEntry(makeRegistryEntry({ label: 'worker-1' }));
		const { pi, handlers, sendUserMessage } = fakePi();
		registerBudgetEnforcement(pi);
		const ctx = { abort: vi.fn() };

		handlers.before_agent_start?.({ prompt: 'abort turn' }, ctx);
		handlers.tool_call?.({ toolName: 'bash', input: {} }, ctx);
		const blocked = handlers.tool_call?.({ toolName: 'bash', input: {} }, ctx);

		expect(blocked).toMatchObject({ block: true });
		expect(ctx.abort).toHaveBeenCalledOnce();
		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(findEntry('worker-1')?.budget).toMatchObject({ outcome: 'aborted' });
		handlers.agent_end?.({}, ctx);
	});

	it('scales the live call budget by the scope declared at delegation', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		vi.stubEnv('PI_SUBAGENT_NESTED', '1');
		fs.writeFileSync(
			configPath(),
			JSON.stringify({ roleBudgets: { reviewer: { toolCalls: 1, discoveryCalls: 12 } } }),
		);
		vi.stubEnv('PI_ORCHESTRATION_ROLE', 'reviewer');
		vi.stubEnv('PI_ORCHESTRATION_FLOW', 'f1');
		vi.stubEnv('PI_SUBAGENT_LABEL', 'reviewer-1');
		vi.stubEnv('PI_ORCHESTRATION_SCOPE_PATHS', '2');
		registerEntry(makeRegistryEntry({ label: 'reviewer-1', agent: 'reviewer' }));
		const { pi, handlers } = fakePi();
		registerBudgetEnforcement(pi);
		const ctx = { abort: vi.fn() };

		handlers.before_agent_start?.({ prompt: 'review this' }, ctx);
		// toolCalls 1 plus 2 paths x 2 per-path allowance keeps 5 inspections available.
		for (let i = 0; i < 5; i++) {
			expect(
				handlers.tool_call?.({ toolName: 'read', input: { path: `src/a${i}.ts` } }, ctx),
			).toBeUndefined();
		}
		const blocked = handlers.tool_call?.({ toolName: 'read', input: { path: 'src/a5.ts' } }, ctx);

		expect(blocked).toMatchObject({ block: true });
		expect(findEntry('reviewer-1')?.budget?.limits).toMatchObject({
			toolCalls: 5,
			discoveryCalls: 16,
		});
		handlers.agent_end?.({}, ctx);
	});

	it('charges the output budget for report prose rather than for tool arguments', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		vi.stubEnv('PI_SUBAGENT_NESTED', '1');
		fs.writeFileSync(
			configPath(),
			JSON.stringify({ roleBudgets: { reviewer: { outputTokens: 100 } } }),
		);
		vi.stubEnv('PI_ORCHESTRATION_ROLE', 'reviewer');
		vi.stubEnv('PI_ORCHESTRATION_FLOW', 'f1');
		vi.stubEnv('PI_SUBAGENT_LABEL', 'reviewer-1');
		registerEntry(makeRegistryEntry({ label: 'reviewer-1', agent: 'reviewer' }));
		const { pi, handlers, sendUserMessage } = fakePi();
		registerBudgetEnforcement(pi);
		const ctx = { abort: vi.fn() };

		handlers.before_agent_start?.({ prompt: 'review this' }, ctx);
		handlers.turn_end?.(
			{
				message: assistantMsg('', {
					usage: { output: 5000 },
					toolCalls: [{ id: 'r1', name: 'read', args: { path: 'src/a.ts' } }],
				}),
			},
			ctx,
		);
		expect(findEntry('reviewer-1')?.budget).toMatchObject({
			outcome: 'within',
			usage: { outputTokens: 0, toolArgumentTokens: 5000 },
		});

		handlers.turn_end?.(
			{ message: assistantMsg('the complete review report', { usage: { output: 150 } }) },
			ctx,
		);
		expect(findEntry('reviewer-1')?.budget).toMatchObject({
			outcome: 'report_only',
			steerIssued: false,
			usage: { outputTokens: 150, toolArgumentTokens: 5000 },
			breaches: [{ metric: 'outputTokens', limit: 100, observed: 150 }],
		});
		expect(sendUserMessage).not.toHaveBeenCalled();
		handlers.agent_end?.({}, ctx);
	});

	it('keeps reasoning out of the report budget and records it separately', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		vi.stubEnv('PI_SUBAGENT_NESTED', '1');
		fs.writeFileSync(
			configPath(),
			JSON.stringify({ roleBudgets: { reviewer: { outputTokens: 100 } } }),
		);
		vi.stubEnv('PI_ORCHESTRATION_ROLE', 'reviewer');
		vi.stubEnv('PI_ORCHESTRATION_FLOW', 'f1');
		vi.stubEnv('PI_SUBAGENT_LABEL', 'reviewer-2');
		registerEntry(makeRegistryEntry({ label: 'reviewer-2', agent: 'reviewer' }));
		const { pi, handlers, sendUserMessage } = fakePi();
		registerBudgetEnforcement(pi);
		const ctx = { abort: vi.fn() };

		handlers.before_agent_start?.({ prompt: 'review this' }, ctx);
		handlers.turn_end?.(
			{ message: assistantMsg('the report', { usage: { output: 5_000, reasoning: 4_950 } }) },
			ctx,
		);

		expect(findEntry('reviewer-2')?.budget).toMatchObject({
			outcome: 'within',
			usage: { outputTokens: 50, reasoningTokens: 4_950 },
			breaches: [],
		});
		expect(sendUserMessage).not.toHaveBeenCalled();
		handlers.agent_end?.({}, ctx);
	});

	it('does not abort a child that already delivered its report under an abort policy', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		vi.stubEnv('PI_SUBAGENT_NESTED', '1');
		fs.writeFileSync(
			configPath(),
			JSON.stringify({
				roleBudgets: { reviewer: { outputTokens: 100, budgetPolicy: 'abort' } },
			}),
		);
		vi.stubEnv('PI_ORCHESTRATION_ROLE', 'reviewer');
		vi.stubEnv('PI_ORCHESTRATION_FLOW', 'f1');
		vi.stubEnv('PI_SUBAGENT_LABEL', 'reviewer-3');
		registerEntry(makeRegistryEntry({ label: 'reviewer-3', agent: 'reviewer' }));
		const { pi, handlers } = fakePi();
		registerBudgetEnforcement(pi);
		const ctx = { abort: vi.fn() };

		handlers.before_agent_start?.({ prompt: 'review this' }, ctx);
		handlers.turn_end?.({ message: assistantMsg('the report', { usage: { output: 500 } }) }, ctx);

		expect(ctx.abort).not.toHaveBeenCalled();
		expect(findEntry('reviewer-3')?.budget).toMatchObject({
			outcome: 'report_only',
			breaches: [{ metric: 'outputTokens', limit: 100, observed: 500 }],
		});
		handlers.agent_end?.({}, ctx);
	});
});

describe('budget enforcement - repository contention between siblings', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('refuses a write and a gate while a sibling writes, then admits both once it releases', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		vi.stubEnv('PI_SUBAGENT_NESTED', '1');
		vi.stubEnv('PI_ORCHESTRATION_ROLE', 'worker');
		vi.stubEnv('PI_SUBAGENT_LABEL', 'worker-1');
		vi.stubEnv('PI_ORCHESTRATION_FLOW', 'flow-1');
		registerEntry(makeRegistryEntry({ label: 'worker-1' }));
		const { pi, handlers } = fakePi();
		registerBudgetEnforcement(pi);
		const ctx = { abort: vi.fn() };

		// An implementation change first, so the contention refusal is what the assertions observe.
		handlers.before_agent_start?.({ prompt: 'implement this' }, ctx);
		handlers.tool_call?.(
			{ toolName: 'write', toolCallId: 'call-impl', input: { path: 'src/a.ts', content: 'x' } },
			ctx,
		);

		const sibling = acquireRepositoryWriteLock({
			label: 'worker-9',
			flowId: 'flow-1',
			commandId: 'node_format',
		});
		expect(sibling.acquired).toBe(true);

		const write = handlers.tool_call?.(
			{
				toolName: 'project_command',
				toolCallId: 'call-write',
				input: { commandId: 'node_format' },
			},
			ctx,
		);
		const gate = handlers.tool_call?.(
			{ toolName: 'verify', toolCallId: 'call-gate', input: { paths: ['src/budget.ts'] } },
			ctx,
		);
		// Resolving stored evidence reads nothing from the working tree, so contention is not its problem.
		const lookup = handlers.tool_call?.(
			{ toolName: 'verify', toolCallId: 'call-ref', input: { ref: 'vr_x' } },
			ctx,
		);

		expect(write).toMatchObject({ block: true });
		const writeReason = (write as { reason: string }).reason;
		expect(writeReason).toContain('worker-9');
		expect(writeReason).toContain('node_format');
		expect(writeReason).toContain('Retry');
		expect(gate).toMatchObject({ block: true });
		expect((gate as { reason: string }).reason).toContain('half-written');
		expect(lookup).toBeUndefined();

		if (sibling.acquired) releaseRepositoryWriteLock(sibling.handle);
		const retry = handlers.tool_call?.(
			{
				toolName: 'project_command',
				toolCallId: 'call-retry',
				input: { commandId: 'node_format' },
			},
			ctx,
		);
		expect(retry).toBeUndefined();
		// The admitted write now holds the repository itself, and its tool_result hands it back.
		expect(probeRepositoryWriteLock({ label: 'worker-9' })?.holder?.label).toBe('worker-1');
		handlers.tool_result?.(
			{
				toolName: 'project_command',
				toolCallId: 'call-retry',
				input: { commandId: 'node_format' },
				content: [],
				isError: false,
			},
			ctx,
		);
		expect(probeRepositoryWriteLock({ label: 'worker-9' })).toBeUndefined();
		settleBudget(handlers, ctx);
		expect(findEntry('worker-1')?.budget).toMatchObject({
			usage: { toolCalls: 5, fullValidationPasses: 1 },
			repositoryWriteLockRefusals: 2,
		});

		handlers.agent_end?.({}, ctx);
	});

	it('refuses a validator gate while a sibling writes and still admits ref lookups', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		vi.stubEnv('PI_SUBAGENT_NESTED', '1');
		vi.stubEnv('PI_ORCHESTRATION_ROLE', 'validator');
		vi.stubEnv('PI_SUBAGENT_LABEL', 'validator-1');
		vi.stubEnv('PI_ORCHESTRATION_FLOW', 'flow-1');
		registerEntry(makeRegistryEntry({ label: 'validator-1', agent: 'validator' }));
		const { pi, handlers } = fakePi();
		registerBudgetEnforcement(pi);
		const ctx = { abort: vi.fn() };

		const sibling = acquireRepositoryWriteLock({
			label: 'worker-9',
			flowId: 'flow-1',
			commandId: 'node_lint:fix',
		});
		expect(sibling.acquired).toBe(true);

		const gate = handlers.tool_call?.(
			{ toolName: 'verify', toolCallId: 'call-gate', input: { paths: ['src/budget.ts'] } },
			ctx,
		);
		const remainder = handlers.tool_call?.(
			{
				toolName: 'project_command',
				toolCallId: 'call-tc',
				input: { commandId: 'node_typecheck' },
			},
			ctx,
		);
		const lookup = handlers.tool_call?.(
			{ toolName: 'verify', toolCallId: 'call-ref', input: { ref: 'vr_x' } },
			ctx,
		);

		expect(gate).toMatchObject({ block: true });
		expect(remainder).toMatchObject({ block: true });
		expect(lookup).toBeUndefined();
		// A refused check is not charged: the validator keeps its passes for the state it can measure.
		settleBudget(handlers, ctx);
		expect(findEntry('validator-1')?.budget).toMatchObject({
			usage: { toolCalls: 3, fullValidationPasses: 0 },
			repositoryWriteLockRefusals: 2,
		});

		if (sibling.acquired) releaseRepositoryWriteLock(sibling.handle);
		handlers.agent_end?.({}, ctx);
	});

	it('lets siblings write concurrently when repositoryWriteLock is off', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		fs.writeFileSync(
			configPath(),
			JSON.stringify({ ...structuredClone(DEFAULT_CONFIG), repositoryWriteLock: false }),
		);
		vi.stubEnv('PI_SUBAGENT_NESTED', '1');
		vi.stubEnv('PI_ORCHESTRATION_ROLE', 'worker');
		vi.stubEnv('PI_SUBAGENT_LABEL', 'worker-1');
		registerEntry(makeRegistryEntry({ label: 'worker-1' }));
		const { pi, handlers } = fakePi();
		registerBudgetEnforcement(pi);
		const ctx = { abort: vi.fn() };

		const sibling = acquireRepositoryWriteLock({ label: 'worker-9', commandId: 'node_format' });
		expect(sibling.acquired).toBe(true);

		const write = handlers.tool_call?.(
			{
				toolName: 'project_command',
				toolCallId: 'call-write',
				input: { commandId: 'node_format' },
			},
			ctx,
		);
		expect(write).toBeUndefined();
		// With the exclusion off, the child never touches the lock the sibling is holding.
		expect(probeRepositoryWriteLock({ label: 'worker-2' })?.holder?.label).toBe('worker-9');

		if (sibling.acquired) releaseRepositoryWriteLock(sibling.handle);
		handlers.agent_end?.({}, ctx);
	});

	it('leaves no hold behind when another rule refuses the call first', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		fs.writeFileSync(configPath(), JSON.stringify({ roleBudgets: { worker: { toolCalls: 1 } } }));
		vi.stubEnv('PI_SUBAGENT_NESTED', '1');
		vi.stubEnv('PI_ORCHESTRATION_ROLE', 'worker');
		vi.stubEnv('PI_SUBAGENT_LABEL', 'worker-1');
		vi.stubEnv('PI_ORCHESTRATION_FLOW', 'flow-1');
		registerEntry(makeRegistryEntry({ label: 'worker-1' }));
		const { pi, handlers } = fakePi();
		registerBudgetEnforcement(pi);
		const ctx = { abort: vi.fn() };

		handlers.before_agent_start?.({ prompt: 'implement this' }, ctx);
		expect(
			handlers.tool_call?.({ toolName: 'read', input: { path: 'src/a.ts' } }, ctx),
		).toBeUndefined();
		// The budget refusal fires first and a refused call produces no tool_result, so the exclusion
		// must be the last gate: a leaked hold would exclude every sibling over a command that never ran.
		const refused = handlers.tool_call?.(
			{
				toolName: 'project_command',
				toolCallId: 'call-write',
				input: { commandId: 'node_format' },
			},
			ctx,
		);
		expect(refused).toMatchObject({ block: true });
		expect((refused as { reason: string }).reason).not.toContain('is writing this repository');
		expect(probeRepositoryWriteLock({ label: 'a-sibling', flowId: 'flow-1' })).toBeUndefined();

		handlers.agent_end?.({}, ctx);
	});

	// The refusal is the only thing an operator sees, so it must not name a session it did not read and
	// must not call corruption a permission problem.
	it('names no holder when the hold cannot be identified', async () => {
		const dir = makeTempDir();
		stubEnv(dir);
		vi.stubEnv('PI_SUBAGENT_NESTED', '1');
		vi.stubEnv('PI_ORCHESTRATION_ROLE', 'worker');
		vi.stubEnv('PI_ORCHESTRATION_FLOW', 'flow-1');
		registerEntry(makeRegistryEntry({ label: 'worker-1' }));
		const lockPath = repositoryWriteLockPath();
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		fs.writeFileSync(lockPath, '{"x":1}');
		const { pi, handlers } = fakePi();
		registerBudgetEnforcement(pi);

		handlers.before_agent_start?.({ prompt: 'implement this' }, { abort: vi.fn() });
		const blocked = handlers.tool_call?.(
			{
				toolName: 'verify',
				toolCallId: 'call-blocked',
				input: { covers: ['AC-001'] },
			},
			{ abort: vi.fn() },
		);
		expect(blocked).toMatchObject({ block: true });
		const reason = (blocked as { reason: string }).reason;
		expect(reason).toContain('cannot identify');
		expect(reason).not.toContain('Session ');
		expect(reason).not.toContain('cannot read');
		fs.rmSync(lockPath, { force: true });
	});

	it('treats a same-label sibling from another flow as a foreign writer', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		vi.stubEnv('PI_SUBAGENT_NESTED', '1');
		vi.stubEnv('PI_ORCHESTRATION_ROLE', 'worker');
		vi.stubEnv('PI_SUBAGENT_LABEL', 'worker-1');
		vi.stubEnv('PI_ORCHESTRATION_FLOW', 'flow-1');
		registerEntry(makeRegistryEntry({ label: 'worker-1' }));
		const { pi, handlers } = fakePi();
		registerBudgetEnforcement(pi);
		const ctx = { abort: vi.fn() };

		handlers.before_agent_start?.({ prompt: 'implement this' }, ctx);
		handlers.tool_call?.(
			{ toolName: 'write', toolCallId: 'call-impl', input: { path: 'src/a.ts', content: 'x' } },
			ctx,
		);

		// Labels are allocated per delegating session, so two flows on one checkout both own a worker-1.
		const otherFlow = acquireRepositoryWriteLock({
			label: 'worker-1',
			flowId: 'flow-2',
			commandId: 'node_format',
		});
		expect(otherFlow.acquired).toBe(true);

		const gate = handlers.tool_call?.(
			{ toolName: 'verify', toolCallId: 'call-gate', input: { paths: ['src/budget.ts'] } },
			ctx,
		);
		const write = handlers.tool_call?.(
			{
				toolName: 'project_command',
				toolCallId: 'call-write',
				input: { commandId: 'node_format' },
			},
			ctx,
		);
		expect(gate).toMatchObject({ block: true });
		expect(write).toMatchObject({ block: true });
		expect((write as { reason: string }).reason).toContain('worker-1');

		if (otherFlow.acquired) releaseRepositoryWriteLock(otherFlow.handle);
		handlers.agent_end?.({}, ctx);
	});

	it('excludes a build as a repository write without granting it to roles that may not write', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		vi.stubEnv('PI_SUBAGENT_NESTED', '1');
		vi.stubEnv('PI_ORCHESTRATION_ROLE', 'validator');
		vi.stubEnv('PI_SUBAGENT_LABEL', 'validator-1');
		vi.stubEnv('PI_ORCHESTRATION_FLOW', 'flow-1');
		registerEntry(makeRegistryEntry({ label: 'validator-1', agent: 'validator' }));
		const { pi, handlers } = fakePi();
		registerBudgetEnforcement(pi);
		const ctx = { abort: vi.fn() };

		// A build writes generated output, so it needs the exclusion; it is not a source write, so the
		// mutatingCommandRoles grant still allows it to a validator.
		expect(isExclusiveWriteCommandId('node_build')).toBe(true);
		expect(isMutatingCommandId('node_build')).toBe(false);
		expect(isExclusiveWriteCommandId('node_test:coverage')).toBe(true);
		expect(isExclusiveWriteCommandId('node_test:update-snapshots')).toBe(true);
		expect(isExclusiveWriteCommandId('node_format:check')).toBe(false);
		expect(isExclusiveWriteCommandId('node_typecheck')).toBe(false);

		const build = handlers.tool_call?.(
			{
				toolName: 'project_command',
				toolCallId: 'call-build',
				input: { commandId: 'node_build' },
			},
			ctx,
		);
		expect(build).toBeUndefined();
		expect(
			probeRepositoryWriteLock({ label: 'a-sibling', flowId: 'flow-1' })?.holder?.commandId,
		).toBe('node_build');
		handlers.tool_result?.(
			{
				toolName: 'project_command',
				toolCallId: 'call-build',
				input: { commandId: 'node_build' },
				content: [],
				isError: false,
			},
			ctx,
		);
		expect(probeRepositoryWriteLock({ label: 'a-sibling', flowId: 'flow-1' })).toBeUndefined();

		const sibling = acquireRepositoryWriteLock({
			label: 'worker-9',
			flowId: 'flow-1',
			commandId: 'node_build',
		});
		expect(sibling.acquired).toBe(true);
		const contended = handlers.tool_call?.(
			{
				toolName: 'project_command',
				toolCallId: 'call-build-2',
				input: { commandId: 'node_build' },
			},
			ctx,
		);
		expect(contended).toMatchObject({ block: true });
		expect((contended as { reason: string }).reason).toContain('second concurrent write');

		if (sibling.acquired) releaseRepositoryWriteLock(sibling.handle);
		handlers.agent_end?.({}, ctx);
	});
});
