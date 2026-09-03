import * as fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configPath } from '../src/config.ts';
import {
	BUDGET_STEER_PREFIX,
	classifyToolCall,
	isReportRead,
	readRequestKey,
	registerBudgetEnforcement,
} from '../src/budget.ts';
import { findEntry, registerEntry } from '../src/registry.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { makeRegistryEntry, makeTempDir, stubEnv } from './helpers.ts';

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

describe('budget classification', () => {
	it('classifies discovery, validation, and ordinary calls', () => {
		expect(classifyToolCall('read', { path: 'src/index.ts' })).toBe('discovery');
		expect(classifyToolCall('project_command', { commandId: 'node_test' })).toBe('validation');
		expect(classifyToolCall('project_command', { commandId: 'node_project_info' })).toBe(
			'discovery',
		);
		expect(classifyToolCall('edit', { path: 'src/index.ts' })).toBeUndefined();
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

describe('live budget enforcement', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
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

	it('resets live usage and steering state at the start of a reuse turn', () => {
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
});
