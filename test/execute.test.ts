import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { SubagentExecutionParams } from '../src/execute.ts';
import { deriveFlowId } from '../src/delegation.ts';
import type { SubagentDetails, SubagentRefusalKind } from '../src/types.ts';
import { makeRegistryEntry, makeTempDir, stubEnv, writeAgentFile } from './helpers.ts';

let dir: string;

beforeEach(() => {
	vi.resetModules();
	dir = makeTempDir();
	stubEnv(dir);
});

afterEach(() => {
	vi.doUnmock('../src/run.ts');
	vi.unstubAllEnvs();
});

function ctx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		cwd: dir,
		hasUI: false,
		sessionManager: { getSessionFile: () => undefined },
		ui: {} as ExtensionContext['ui'],
		modelRegistry: { find: () => ({}) } as never,
		...overrides,
	} as ExtensionContext;
}

async function loadExecute() {
	return import('../src/execute.ts');
}

async function execSubagent(
	params: SubagentExecutionParams,
	overrides: Partial<ExtensionContext> = {},
) {
	const { executeSubagent } = await loadExecute();
	return executeSubagent(params, undefined, undefined, ctx(overrides));
}

/** A refusal is an error result carrying its machine-readable kind beside the unchanged text. */
function expectRefusal(result: AgentToolResult<SubagentDetails>, kind: SubagentRefusalKind): void {
	expect(result.isError).toBe(true);
	expect(result.details.refusal?.kind).toBe(kind);
}

async function seedRegistry(entries: ReturnType<typeof makeRegistryEntry>[]) {
	const { registerEntry } = await import('../src/registry.ts');
	for (const e of entries) registerEntry(e);
}

function writeProjectAgent(name: string, description: string): void {
	const agentsDir = path.join(dir, '.pi', 'agents');
	fs.mkdirSync(agentsDir, { recursive: true });
	writeAgentFile(agentsDir, `${name}.md`, 'project prompt', { name, description });
}

function writeUserAgents(...names: string[]): void {
	const agentsDir = path.join(dir, 'agents');
	fs.mkdirSync(agentsDir, { recursive: true });
	for (const name of names)
		writeAgentFile(agentsDir, `${name}.md`, `${name} prompt`, { name, description: name });
}

function writeConfig(partial: Record<string, unknown>): void {
	fs.writeFileSync(path.join(dir, 'subagent-herdr.config.json'), JSON.stringify(partial));
}

describe('executeSubagent - mode validation', () => {
	it('rejects empty parameters', async () => {
		const result = await execSubagent({});
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: 'Invalid parameters. Provide exactly one mode (single, parallel, chain, reuse, list, or agents).\nAvailable agents: none',
		});
		// Refusals are error results with a machine-readable reason, not empty successes.
		expectRefusal(result, 'invalid-params');
		expect(result.details.refusal?.message).toBe(
			'Invalid parameters. Provide exactly one mode (single, parallel, chain, reuse, list, or agents).\nAvailable agents: none',
		);
	});

	it('rejects multiple modes at once', async () => {
		const result = await execSubagent({ agent: 'worker', task: 'x', listSubagents: true });
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('Provide exactly one mode'),
		});
	});

	it('lists available agents in invalid responses', async () => {
		const agentsDir = path.join(dir, 'agents');
		fs.mkdirSync(agentsDir, { recursive: true });
		writeAgentFile(agentsDir, 'worker.md', 'prompt', { name: 'worker', description: 'd' });
		const result = await execSubagent({});
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('Available agents: worker (user)'),
		});
	});
});

describe('executeSubagent - agents listing', () => {
	it('lists agents with name, source, description, and preset-resolved model', async () => {
		const agentsDir = path.join(dir, 'agents');
		fs.mkdirSync(agentsDir, { recursive: true });
		writeAgentFile(agentsDir, 'worker.md', 'prompt', {
			name: 'worker',
			description: 'executes tasks',
		});
		writeAgentFile(agentsDir, 'reviewer.md', 'prompt', {
			name: 'reviewer',
			description: 'reviews code',
			model: 'ignored-frontmatter-model',
		});
		writeConfig({
			modelPresets: { cheap: { reviewer: 'prov/test-model:high' } },
			defaultPreset: 'cheap',
		});
		const result = await execSubagent({ agents: true });
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('- worker (user) - executes tasks, model: (pi default)'),
		});
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining(
				'- reviewer (user) - reviews code, model: prov/test-model:high',
			),
		});
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('model preset: cheap'),
		});
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.not.stringContaining('ignored-frontmatter-model'),
		});
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('do not invent agent names'),
		});
	});

	it('falls back to the pi default for preset models missing from the registry', async () => {
		const agentsDir = path.join(dir, 'agents');
		fs.mkdirSync(agentsDir, { recursive: true });
		writeAgentFile(agentsDir, 'worker.md', 'prompt', {
			name: 'worker',
			description: 'executes tasks',
		});
		writeConfig({
			modelPresets: { cheap: { worker: 'p/gone:high' } },
			defaultPreset: 'cheap',
		});
		const result = await execSubagent({ agents: true }, {
			modelRegistry: { find: () => undefined },
		} as unknown as Partial<ExtensionContext>);
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('- worker (user) - executes tasks, model: (pi default)'),
		});
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('model preset: cheap'),
		});
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.not.stringContaining('p/gone:high'),
		});
	});

	it('does not resolve inherited properties for agents when no preset is active', async () => {
		const agentsDir = path.join(dir, 'agents');
		fs.mkdirSync(agentsDir, { recursive: true });
		writeAgentFile(agentsDir, 'constructor.md', 'prompt', {
			name: 'constructor',
			description: 'oddly named',
		});
		const result = await execSubagent({ agents: true });
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('- constructor (user) - oddly named, model: (pi default)'),
		});
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.not.stringContaining('model: function'),
		});
	});

	it('uses the session preset override for the resolved models', async () => {
		const agentsDir = path.join(dir, 'agents');
		fs.mkdirSync(agentsDir, { recursive: true });
		writeAgentFile(agentsDir, 'worker.md', 'prompt', {
			name: 'worker',
			description: 'executes tasks',
		});
		writeConfig({
			modelPresets: {
				cheap: { worker: 'p/cheap:low' },
				deep: { worker: 'p/deep:high' },
			},
			defaultPreset: 'cheap',
		});
		const result = await execSubagent({ agents: true }, {
			sessionManager: {
				getSessionFile: () => '/sess/current.jsonl',
				getBranch: () => [
					{ type: 'custom', customType: 'subagent-herdr-preset', data: { preset: 'deep' } },
				],
			},
		} as Partial<ExtensionContext>);
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('- worker (user) - executes tasks, model: p/deep:high'),
		});
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('model preset: deep'),
		});
	});

	it('includes project agents for the both scope', async () => {
		const agentsDir = path.join(dir, 'agents');
		fs.mkdirSync(agentsDir, { recursive: true });
		writeAgentFile(agentsDir, 'worker.md', 'prompt', { name: 'worker', description: 'd' });
		writeProjectAgent('pworker', 'project agent');
		const result = await execSubagent({ agents: true, agentScope: 'both' });
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('- worker (user)'),
		});
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('- pworker (project) - project agent'),
		});
	});

	it('reports when no agents are available', async () => {
		const result = await execSubagent({ agents: true });
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('No agents found for agentScope "user"'),
		});
		// An explicit listing is informational, not a refusal: it stays a normal result.
		expect(result.isError).toBeUndefined();
		expect(result.details.refusal).toBeUndefined();
	});

	it('rejects agents combined with another mode', async () => {
		const result = await execSubagent({ agents: true, agent: 'worker', task: 'x' });
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('Provide exactly one mode'),
		});
	});
});

describe('executeSubagent - reuse and single lookups', () => {
	it('requires a task for reuse', async () => {
		const result = await execSubagent(
			{ reuseLabel: 'worker-1' },
			{ sessionManager: { getSessionFile: () => '/sess/current.jsonl' } as never },
		);
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: 'Invalid parameters. reuseLabel requires a task (the next message for that session).',
		});
		expectRefusal(result, 'reuse-without-task');
		expect(result.details.refusal?.message).toBe(
			'Invalid parameters. reuseLabel requires a task (the next message for that session).',
		);
	});

	it('reports unknown reuse labels', async () => {
		const result = await execSubagent(
			{ reuseLabel: 'ghost-1', task: 'hi' },
			{ sessionManager: { getSessionFile: () => '/sess/current.jsonl' } as never },
		);
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('No subagent session labeled "ghost-1"'),
		});
	});

	it('fails closed before reuse when the current Pi session has no session file', async () => {
		await seedRegistry([makeRegistryEntry({ parentSession: '/sess/other.jsonl' })]);
		const { readRegistry } = await import('../src/registry-store.ts');
		const before = readRegistry();
		const result = await execSubagent({ reuseLabel: 'worker-1', task: 'next task' });
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('session ownership is unavailable'),
		});
		expectRefusal(result, 'session-unavailable');
		expect(readRegistry()).toEqual(before);
	});

	it('accepts an expanded payload with empty optional fields (single mode)', async () => {
		const result = await execSubagent({
			agent: 'ghost',
			task: 'x',
			tasks: [],
			chain: [],
			agentScope: 'user',
			confirmProjectAgents: true,
			cwd: dir,
			listSubagents: false,
			listLabel: '',
			listStatus: '',
			listVerbose: false,
			agents: false,
			reuseLabel: '',
		});
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('Unknown agent: "ghost"'),
		});
		expect(result.details).toMatchObject({ mode: 'single' });
	});

	it('reports unknown agents in single mode', async () => {
		const result = await execSubagent({ agent: 'ghost', task: 'x' });
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('Unknown agent: "ghost"'),
		});
		expect(result.details).toMatchObject({
			mode: 'single',
			results: [{ exitCode: 1, agent: 'ghost' }],
		});
	});
});

function mockSuccessfulRuns() {
	vi.doMock('../src/run.ts', () => ({
		runSingleAgent: vi
			.fn()
			.mockImplementation(async (_defaultCwd, _agents, agent, task, _cwd, step) => ({
				agent,
				agentSource: 'user',
				task,
				exitCode: 0,
				messages: [],
				stderr: '',
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					contextTokens: 0,
					turns: 0,
				},
				label: `${agent}-${step ?? 1}`,
				step,
			})),
		runReusedAgent: vi.fn().mockResolvedValue({
			agent: 'worker',
			agentSource: 'reuse',
			task: 'next task',
			exitCode: 0,
			messages: [],
			stderr: '',
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			label: 'worker-1',
		}),
	}));
}

describe('executeSubagent - model-facing reuse labels', () => {
	beforeEach(() => {
		fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
		writeAgentFile(path.join(dir, 'agents'), 'worker.md', 'prompt', {
			name: 'worker',
			description: 'worker',
		});
		writeAgentFile(path.join(dir, 'agents'), 'reviewer.md', 'prompt', {
			name: 'reviewer',
			description: 'reviewer',
		});
	});

	it('exposes a fresh single label as explicit reuse metadata', async () => {
		mockSuccessfulRuns();
		const result = await execSubagent({ agent: 'worker', task: 'do work' });
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('reuseLabel: worker-1'),
		});
	});

	it('identifies reused labels and every chain and parallel label', async () => {
		mockSuccessfulRuns();
		const reused = await execSubagent(
			{ reuseLabel: 'worker-1', task: 'next task' },
			{ sessionManager: { getSessionFile: () => '/sess/current.jsonl' } as never },
		);
		expect(reused.content[0]).toMatchObject({
			text: expect.stringContaining('reuseLabel: worker-1'),
		});

		const chain = await execSubagent({
			chain: [
				{ agent: 'worker', task: 'first' },
				{ agent: 'reviewer', task: 'second' },
			],
		});
		expect(chain.content[0]).toMatchObject({
			text: expect.stringContaining('step 1: reuseLabel: worker-1'),
		});
		expect(chain.content[0]).toMatchObject({
			text: expect.stringContaining('step 2: reuseLabel: reviewer-2'),
		});

		const parallel = await execSubagent({
			tasks: [
				{ agent: 'worker', task: 'first' },
				{ agent: 'reviewer', task: 'second' },
			],
		});
		expect(parallel.content[0]).toMatchObject({
			text: expect.stringContaining('reuseLabel: worker-1'),
		});
		expect(parallel.content[0]).toMatchObject({
			text: expect.stringContaining('reuseLabel: reviewer-1'),
		});
	});

	it('describes the list, stats, and reuse sequence in the parameter schema', async () => {
		const { SubagentParams } = await loadExecute();
		const schemaText = JSON.stringify(SubagentParams);
		expect(schemaText).toContain('call subagent with listSubagents: true');
		expect(schemaText).toContain('call subagent_stats');
		expect(schemaText).toContain('Never infer or increment labels');
		expect(schemaText).toContain('another workspace');
		expect(schemaText).toContain('workspace:label');
	});
});

describe('executeSubagent - listing', () => {
	it('fails closed when the current Pi session has no session file', async () => {
		await seedRegistry([makeRegistryEntry({ parentSession: '/sess/other.jsonl' })]);
		const result = await execSubagent({ listSubagents: true });
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('session ownership is unavailable'),
		});
		expectRefusal(result, 'session-unavailable');
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.not.stringContaining('worker-1'),
		});
	});

	it('lists subagents with filters', async () => {
		await seedRegistry([
			makeRegistryEntry({ status: 'running', parentSession: '/sess/current.jsonl' }),
			makeRegistryEntry({
				label: 'reviewer-1',
				agent: 'reviewer',
				status: 'done',
				parentSession: '/sess/current.jsonl',
			}),
		]);
		const result = await execSubagent(
			{ listSubagents: true, listStatus: 'running' },
			{ sessionManager: { getSessionFile: () => '/sess/current.jsonl' } as never },
		);
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('worker-1'),
		});
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.not.stringContaining('reviewer-1'),
		});
		// A listing is informational, not a refusal, and the projection carries no listing surface.
		expect(result.isError).toBeUndefined();
		expect(result.details.refusal).toBeUndefined();
	});
	it('lists only subagents owned by the active Pi session', async () => {
		await seedRegistry([
			makeRegistryEntry({ label: 'worker-1', parentSession: '/sess/current.jsonl' }),
			makeRegistryEntry({ label: 'worker-2', parentSession: '/sess/other.jsonl' }),
		]);
		const result = await execSubagent(
			{ listSubagents: true },
			{ sessionManager: { getSessionFile: () => '/sess/current.jsonl' } as never },
		);
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('ws1:worker-1'),
		});
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.not.stringContaining('ws1:worker-2'),
		});
	});
});

describe('executeSubagent - parallel and chain', () => {
	it('rejects too many parallel tasks', async () => {
		const tasks = Array.from({ length: 9 }, (_, i) => ({ agent: `a${i}`, task: `t${i}` }));
		const result = await execSubagent({ tasks });
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('Too many parallel tasks (9)'),
		});
		expectRefusal(result, 'too-many-tasks');
	});

	it('respects maxParallelTasks from config', async () => {
		writeConfig({ maxParallelTasks: 2 });
		const tasks = [
			{ agent: 'a', task: 't' },
			{ agent: 'b', task: 'u' },
			{ agent: 'c', task: 'v' },
		];
		const result = await execSubagent({ tasks });
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('Too many parallel tasks (3). Max is 2.'),
		});
		expectRefusal(result, 'too-many-tasks');
	});

	it('rejects equivalent overlapping parallel scopes before fan-out', async () => {
		const { runSingleAgent } = await mockedRuns();
		const result = await execSubagent({
			tasks: [
				{ agent: 'worker', task: 'a', scope: { paths: ['src//run.ts'] } },
				{ agent: 'worker', task: 'b', scope: { paths: ['./src/run.ts'] } },
			],
		});
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('Parallel review scopes overlap at src/run.ts'),
		});
		expectRefusal(result, 'overlapping-scope');
		expect(runSingleAgent).not.toHaveBeenCalled();
	});

	it('rejects overlapping inherited parent scopes before fan-out', async () => {
		const { runSingleAgent } = await mockedRuns();
		const result = await execSubagent({
			scope: { paths: ['src'] },
			tasks: [
				{ agent: 'worker', task: 'a' },
				{ agent: 'reviewer', task: 'b' },
			],
		});
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('Parallel review scopes overlap at src'),
		});
		expectRefusal(result, 'overlapping-scope');
		expect(runSingleAgent).not.toHaveBeenCalled();
	});

	it('pre-digests the review surface before parallel fan-out', async () => {
		const { runSingleAgent } = await mockedRuns();
		const result = await execSubagent(
			{
				tasks: [
					{ agent: 'worker', task: 'a', scope: { paths: ['src/run.ts'] } },
					{ agent: 'reviewer', task: 'b', scope: { paths: ['src/execute.ts'] } },
				],
			},
			{ sessionManager: { getSessionFile: () => '/sess/current.jsonl' } as never },
		);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining('Parallel:') });
		expect(runSingleAgent.mock.calls.map((call) => call[12])).toEqual([
			expect.objectContaining({
				scope: { paths: ['src/run.ts'] },
				reviewSurfacePath: expect.any(String),
			}),
			expect.objectContaining({
				scope: { paths: ['src/execute.ts'] },
				reviewSurfacePath: expect.any(String),
			}),
		]);
	});

	it('aggregates failed parallel runs', async () => {
		const result = await execSubagent({
			tasks: [
				{ agent: 'ghost1', task: 'a' },
				{ agent: 'ghost2', task: 'b' },
			],
		});
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('Parallel: 0/2 succeeded'),
		});
		expect(result.details).toMatchObject({
			mode: 'parallel',
			results: [{ exitCode: 1 }, { exitCode: 1 }],
		});
	});

	it('stops chains at the first failing step', async () => {
		const result = await execSubagent({
			chain: [
				{ agent: 'ghost', task: 'a' },
				{ agent: 'worker', task: 'b' },
			],
		});
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('Chain stopped at step 1 (ghost)'),
		});
		expect(result.details).toMatchObject({
			mode: 'chain',
			results: [{ agent: 'ghost', step: 1, exitCode: 1 }],
		});
	});
});

describe('executeSubagent - composition policy', () => {
	beforeEach(() => {
		writeUserAgents('validator', 'reviewer', 'worker', 'planner');
		mockSuccessfulRuns();
	});

	it('warns once for a tier 1 validator and names the worker verify ref', async () => {
		const result = await execSubagent(
			{ agent: 'validator', task: 'check', tier: 1 },
			{ sessionManager: { getSessionFile: () => '/sess/current.jsonl' } as never },
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain('Composition warning [R1]');
		expect(text).toContain('worker verify ref');
		expect(text.match(/Composition warning \[R1\]/g)).toHaveLength(1);
		expect((await import('../src/run.ts')).runSingleAgent).toHaveBeenCalledTimes(1);
		const telemetry = (await import('../src/telemetry.ts')).readTelemetryRecords();
		expect(telemetry.filter((record) => record.event === 'composition')).toHaveLength(1);
		expect(telemetry.at(-1)).toMatchObject({
			event: 'composition',
			flowId: deriveFlowId('/sess/current.jsonl'),
			compositionPolicy: 'warn',
			compositionVerdict: { rule: 'R1', action: 'warn', policy: 'warn' },
		});
		expect(telemetry.at(-1)).not.toHaveProperty('compositionPolicyOverride');
	});

	it('enforces tier 1 validator refusal before a child exists', async () => {
		writeConfig({ compositionPolicy: 'enforce' });
		const result = await execSubagent(
			{ agent: 'validator', task: 'check', tier: 1 },
			{ sessionManager: { getSessionFile: () => '/sess/current.jsonl' } as never },
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain('Composition refusal [R1]');
		expect(text).toContain('worker verify ref');
		expectRefusal(result, 'composition');
		expect((await import('../src/run.ts')).runSingleAgent).not.toHaveBeenCalled();
		expect(result.details).toMatchObject({ mode: 'single', results: [] });
		const telemetry = (await import('../src/telemetry.ts')).readTelemetryRecords();
		expect(telemetry.at(-1)).toMatchObject({
			event: 'composition',
			flowId: deriveFlowId('/sess/current.jsonl'),
			compositionPolicy: 'enforce',
			compositionVerdict: { rule: 'R1', action: 'refuse', policy: 'enforce' },
		});
	});

	it('uses a per-call override and supports off without emitting a composition event', async () => {
		writeConfig({ compositionPolicy: 'off' });
		const overridden = await execSubagent({
			agent: 'validator',
			task: 'check',
			tier: 1,
			compositionPolicy: 'enforce',
		});
		expect((overridden.content[0] as { text: string }).text).toContain('Composition refusal [R1]');
		expectRefusal(overridden, 'composition');
		expect((await import('../src/run.ts')).runSingleAgent).not.toHaveBeenCalled();
		const telemetry = (await import('../src/telemetry.ts')).readTelemetryRecords();
		expect(telemetry.filter((record) => record.event === 'composition')).toHaveLength(1);
		expect(telemetry.find((record) => record.event === 'composition')).toMatchObject({
			compositionPolicy: 'enforce',
			compositionPolicyOverride: 'enforce',
			compositionVerdict: { action: 'refuse' },
		});
		const off = await execSubagent({ agent: 'validator', task: 'check', tier: 1 });
		expect((off.content[0] as { text: string }).text).not.toContain('Composition');
		expect((await import('../src/run.ts')).runSingleAgent).toHaveBeenCalledTimes(1);
		const offPreflight = (await import('../src/telemetry.ts'))
			.readTelemetryRecords()
			.find((record) => record.event === 's4_preflight' && record.s4Preflight?.policy === 'off');
		expect(offPreflight?.s4Preflight?.observations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ ruleId: 'R1', eligible: true, action: 'disabled' }),
				expect.objectContaining({ ruleId: 'R2', eligible: false, action: 'not_applicable' }),
				expect.objectContaining({ ruleId: 'R3', eligible: false, action: 'not_applicable' }),
				expect.objectContaining({ ruleId: 'R4', eligible: false, action: 'not_applicable' }),
			]),
		);
		expect(
			(await import('../src/telemetry.ts'))
				.readTelemetryRecords()
				.filter((record) => record.event === 'composition'),
		).toHaveLength(1);
	});

	it('warns a tier 2 validator without session evidence and accepts session evidence', async () => {
		const warned = await execSubagent({ agent: 'validator', task: 'check', tier: 2 });
		expect((warned.content[0] as { text: string }).text).toContain('Composition warning [R3]');
		const clean = await execSubagent({
			agent: 'validator',
			task: 'check',
			tier: 2,
			evidenceScope: 'session',
		});
		expect((clean.content[0] as { text: string }).text).not.toContain('Composition warning [R3]');
		expect((await import('../src/run.ts')).runSingleAgent).toHaveBeenCalledTimes(2);
	});

	it('warns a tier 3 worker without a preceding planner, once in a chain', async () => {
		const result = await execSubagent({
			chain: [{ agent: 'worker', task: 'work' }],
			tier: 3,
		});
		const text = (result.content[0] as { text: string }).text;
		expect(text.match(/Composition warning \[R4\]/g)).toHaveLength(1);
		expect(text).toContain('preceding planner');
		expect((await import('../src/run.ts')).runSingleAgent).toHaveBeenCalledTimes(1);
	});

	it('does not warn for a worker after a planner in a chain', async () => {
		const result = await execSubagent({
			chain: [
				{ agent: 'planner', task: 'plan' },
				{ agent: 'worker', task: 'work' },
			],
			tier: 3,
		});
		expect((result.content[0] as { text: string }).text).not.toContain('Composition warning [R4]');
		expect((await import('../src/run.ts')).runSingleAgent).toHaveBeenCalledTimes(2);
	});

	it('diagnoses both planner orderings in a tier 3 parallel fan-out', async () => {
		const runSingleAgent = (await import('../src/run.ts')).runSingleAgent;
		for (const tasks of [
			[
				{ agent: 'planner', task: 'plan' },
				{ agent: 'worker', task: 'work' },
			],
			[
				{ agent: 'worker', task: 'work' },
				{ agent: 'planner', task: 'plan' },
			],
		]) {
			const result = await execSubagent({ tasks, tier: 3 });
			const text = (result.content[0] as { text: string }).text;
			expect(text).toContain('Composition warning [R4]');
			expect(text).toContain('Tier 3');
			expect(text).toContain('parallel fan-out');
			expect(text).toContain('completed planner');
			expect(text).toContain('Compliant alternative:');
		}
		expect(runSingleAgent).toHaveBeenCalledTimes(4);
	});

	it('refuses both tier 3 parallel planner orderings before spawning any child', async () => {
		writeConfig({ compositionPolicy: 'enforce' });
		const runSingleAgent = (await import('../src/run.ts')).runSingleAgent;
		for (const tasks of [
			[
				{ agent: 'planner', task: 'plan' },
				{ agent: 'worker', task: 'work' },
			],
			[
				{ agent: 'worker', task: 'work' },
				{ agent: 'planner', task: 'plan' },
			],
		]) {
			const result = await execSubagent({ tasks, tier: 3 });
			const text = (result.content[0] as { text: string }).text;
			expect(text).toContain('Composition refusal [R4]');
			expect(text).toContain('Tier 3');
			expect(text).toContain('parallel fan-out');
			expectRefusal(result, 'composition');
			expect(text).toContain('completed planner');
			expect(text).toContain('Compliant alternative:');
			expect(result.details).toMatchObject({ mode: 'parallel', results: [] });
		}
		expect(runSingleAgent).not.toHaveBeenCalled();
	});

	it('warns once for missing parallel reviewer scopes and allows disjoint scopes', async () => {
		const missing = await execSubagent({
			tasks: [
				{ agent: 'reviewer', task: 'a' },
				{ agent: 'reviewer', task: 'b' },
			],
		});
		expect(
			(missing.content[0] as { text: string }).text.match(/Composition warning \[R2\]/g),
		).toHaveLength(1);
		expect((await import('../src/run.ts')).runSingleAgent).toHaveBeenCalledTimes(2);
		const disjoint = await execSubagent({
			tasks: [
				{ agent: 'reviewer', task: 'a', scope: { paths: ['src/a.ts'] } },
				{ agent: 'reviewer', task: 'b', scope: { paths: ['src/b.ts'] } },
			],
		});
		expect((disjoint.content[0] as { text: string }).text).not.toContain(
			'Composition warning [R2]',
		);
		expect((await import('../src/run.ts')).runSingleAgent).toHaveBeenCalledTimes(4);
	});

	it('refuses overlapping reviewer scopes under enforce but keeps general overlap safety under off', async () => {
		writeConfig({ compositionPolicy: 'enforce' });
		const refused = await execSubagent({
			tasks: [
				{ agent: 'reviewer', task: 'a', scope: { paths: ['src'] } },
				{ agent: 'reviewer', task: 'b', scope: { paths: ['src/a.ts'] } },
			],
		});
		expect((refused.content[0] as { text: string }).text).toContain('Composition refusal [R2]');
		expectRefusal(refused, 'composition');
		expect((await import('../src/run.ts')).runSingleAgent).not.toHaveBeenCalled();
		writeConfig({ compositionPolicy: 'off' });
		const safe = await execSubagent({
			tasks: [
				{ agent: 'reviewer', task: 'a', scope: { paths: ['src'] } },
				{ agent: 'reviewer', task: 'b', scope: { paths: ['src/a.ts'] } },
			],
		});
		expect((safe.content[0] as { text: string }).text).toContain('Parallel review scopes overlap');
		expectRefusal(safe, 'overlapping-scope');
	});

	it('leaves unknown agent names untouched', async () => {
		const result = await execSubagent({ agent: 'ghost', task: 'x', tier: 1 });
		const runSingleAgent = (await import('../src/run.ts')).runSingleAgent;
		expect(runSingleAgent).toHaveBeenCalledTimes(1);
		expect(vi.mocked(runSingleAgent).mock.calls[0][2]).toBe('ghost');
		expect((result.content[0] as { text: string }).text).not.toContain('Composition');
	});
});

describe('executeSubagent - project agents', () => {
	it('cancels when project agents are not approved', async () => {
		writeProjectAgent('scout', 'project scout');
		const confirm = vi.fn().mockResolvedValue(false);
		const result = await execSubagent(
			{ agent: 'scout', task: 'x', agentScope: 'project' },
			{ hasUI: true, ui: { confirm } as never },
		);
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: 'Canceled: project-local agents not approved.',
		});
		expectRefusal(result, 'project-agents-denied');
		expect(confirm).toHaveBeenCalledWith(
			'Run project-local agents?',
			expect.stringContaining('scout'),
		);
	});

	it('runs project agents without UI confirm', async () => {
		writeProjectAgent('scout', 'project scout');
		const result = await execSubagent({ agent: 'scout', task: 'x', agentScope: 'project' });
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.not.stringContaining('Canceled: project-local agents not approved'),
		});
	});

	it('uses defaultAgentScope from config', async () => {
		writeProjectAgent('proj', 'project agent');
		writeConfig({ defaultAgentScope: 'both' });
		const result = await execSubagent({});
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('proj (project)'),
		});
	});
});

describe('executeSubagent - nested guard', () => {
	it('blocks nested subagents when PI_SUBAGENT_NESTED is set', async () => {
		vi.resetModules();
		vi.stubEnv('PI_SUBAGENT_NESTED', '1');
		const { executeSubagent } = await import('../src/execute.ts');
		const result = await executeSubagent(
			{ agent: 'worker', task: 'x' },
			undefined,
			undefined,
			ctx(),
		);
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('Nested subagents are disabled'),
		});
		expect(result.details).toMatchObject({ mode: 'single', results: [] });
		expectRefusal(result, 'nested');
	});
});

type RunSpy = ReturnType<typeof vi.fn>;

describe('executeSubagent - spawn boundary', () => {
	beforeEach(() => {
		writeUserAgents('worker');
		mockSuccessfulRuns();
	});

	it('refuses a single-mode cwd outside the root session folder without launching', async () => {
		const result = await execSubagent({ agent: 'worker', task: 'x', cwd: '/tmp' });
		const runSingleAgent = await runSingleAgentSpy();
		expect(runSingleAgent).not.toHaveBeenCalled();
		expectRefusal(result, 'spawn-boundary');
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain('Spawn boundary refusal');
		expect(text).toContain('no child was launched');
		expect(text).toContain("cwd '/tmp'");
		expect(text).toContain("outside this session's root folder");
		expect(text).toContain(`'${dir}'`);
		expect(text).toContain('subfolders of the root are allowed');
	});

	it('allows a single-mode cwd inside the root session folder', async () => {
		const inside = path.join(dir, 'sub');
		const result = await execSubagent({ agent: 'worker', task: 'x', cwd: inside });
		const runSingleAgent = await runSingleAgentSpy();
		expect(runSingleAgent).toHaveBeenCalledTimes(1);
		expect(vi.mocked(runSingleAgent).mock.calls[0][4]).toBe(inside);
		expect((result.content[0] as { text: string }).text).not.toContain('Spawn boundary refusal');
	});

	it('allows a relative cwd inside the root session folder', async () => {
		await execSubagent({ agent: 'worker', task: 'x', cwd: 'sub' });
		const runSingleAgent = await runSingleAgentSpy();
		expect(runSingleAgent).toHaveBeenCalledTimes(1);
		expect(vi.mocked(runSingleAgent).mock.calls[0][4]).toBe('sub');
	});

	it('refuses a relative cwd escaping the root session folder', async () => {
		const result = await execSubagent({ agent: 'worker', task: 'x', cwd: '../outside' });
		const runSingleAgent = await runSingleAgentSpy();
		expect(runSingleAgent).not.toHaveBeenCalled();
		expect((result.content[0] as { text: string }).text).toContain("cwd '../outside'");
		expectRefusal(result, 'spawn-boundary');
	});

	it('refuses a parallel task cwd outside the root session folder', async () => {
		const result = await execSubagent({
			tasks: [
				{ agent: 'worker', task: 'a', cwd: path.join(dir, 'inside') },
				{ agent: 'worker', task: 'b', cwd: path.join(dir, '..', 'outside') },
			],
		});
		const runSingleAgent = await runSingleAgentSpy();
		expect(runSingleAgent).not.toHaveBeenCalled();
		expect((result.content[0] as { text: string }).text).toContain(
			"outside this session's root folder",
		);
		expectRefusal(result, 'spawn-boundary');
	});

	it('refuses a chain step cwd outside the root session folder', async () => {
		const result = await execSubagent({
			chain: [{ agent: 'worker', task: 'a', cwd: path.join(dir, '..', 'outside') }],
		});
		const runSingleAgent = await runSingleAgentSpy();
		expect(runSingleAgent).not.toHaveBeenCalled();
		expect((result.content[0] as { text: string }).text).toContain('Spawn boundary refusal');
		expectRefusal(result, 'spawn-boundary');
	});
});

function mockedRuns() {
	mockSuccessfulRuns();
	return import('../src/run.ts') as unknown as Promise<{
		runSingleAgent: RunSpy;
		runReusedAgent: RunSpy;
	}>;
}

async function runSingleAgentSpy(): Promise<RunSpy> {
	const mod = (await import('../src/run.ts')) as unknown as {
		runSingleAgent: RunSpy;
	};
	return mod.runSingleAgent;
}

describe('executeSubagent - delegation context', () => {
	const context = {
		tier: 3,
		workflowMode: 'remediation' as const,
		reviewMode: 'security' as const,
		acceptanceCriteria: ['F-001', 'bad id'],
		evidenceScope: 'session' as const,
	};

	it('passes the orchestration context to single runs', async () => {
		const { runSingleAgent } = await mockedRuns();
		await execSubagent({ agent: 'worker', task: 'x', ...context });
		expect(runSingleAgent.mock.calls[0][12]).toMatchObject({
			tier: 3,
			workflowMode: 'remediation',
			reviewMode: 'security',
			acceptanceCriteria: ['F-001'],
			evidenceScope: 'session',
			compositionPolicy: 'warn',
			compositionBoundaryId: expect.any(String),
			compositionVerdicts: [
				{
					rule: 'R4',
					action: 'warn',
					verdict: 'warning',
					policy: 'warn',
					mode: 'single',
					agent: 'worker',
					role: 'worker',
					tier: 3,
					reason:
						'Tier 3 worker has no preceding planner in this composition, so the required investigation plan is missing.',
					compliantAlternative:
						'Use a sequential chain with a completed planner before the worker or use a lower tier.',
				},
			],
		});
		expect(runSingleAgent.mock.calls[0][12].compositionVerdicts[0]).not.toHaveProperty('scope');
	});

	it('passes an empty context when nothing is declared', async () => {
		const { runSingleAgent } = await mockedRuns();
		await execSubagent({ agent: 'worker', task: 'x' });
		expect(runSingleAgent.mock.calls[0][12]).toEqual({
			compositionPolicy: 'warn',
			compositionBoundaryId: expect.any(String),
		});
	});

	it('applies the context to every chain delegation', async () => {
		const { runSingleAgent } = await mockedRuns();
		await execSubagent({
			chain: [
				{ agent: 'scout', task: 'a' },
				{ agent: 'worker', task: 'b' },
			],
			tier: 1,
		});
		expect(runSingleAgent.mock.calls.map((call) => call[12])).toEqual([
			{ tier: 1, compositionPolicy: 'warn', compositionBoundaryId: expect.any(String) },
			{ tier: 1, compositionPolicy: 'warn', compositionBoundaryId: expect.any(String) },
		]);
	});

	it('applies the context to every parallel delegation', async () => {
		const { runSingleAgent } = await mockedRuns();
		await execSubagent({
			tasks: [
				{ agent: 'worker', task: 'a' },
				{ agent: 'reviewer', task: 'b' },
			],
			tier: 2,
			evidenceScope: 'session',
		});
		expect(runSingleAgent.mock.calls.map((call) => call[12])).toEqual([
			{
				tier: 2,
				evidenceScope: 'session',
				compositionPolicy: 'warn',
				compositionBoundaryId: expect.any(String),
			},
			{
				tier: 2,
				evidenceScope: 'session',
				compositionPolicy: 'warn',
				compositionBoundaryId: expect.any(String),
			},
		]);
	});

	it('passes the context to reuse turns', async () => {
		const { runReusedAgent } = await mockedRuns();
		await execSubagent(
			{ reuseLabel: 'worker-1', task: 'next task', workflowMode: 'remediation' },
			{ sessionManager: { getSessionFile: () => '/sess/current.jsonl' } as never },
		);
		expect(runReusedAgent.mock.calls[0][10]).toEqual({
			workflowMode: 'remediation',
			compositionPolicy: 'warn',
			compositionBoundaryId: expect.any(String),
		});
		expect(runReusedAgent.mock.calls[0][11]).toEqual(expect.any(String));
		expect(runReusedAgent.mock.calls[0][12]).toMatch(/^s4-/);
	});
});

function mockRunWithReport(report?: Record<string, unknown>) {
	vi.doMock('../src/run.ts', () => ({
		runSingleAgent: vi.fn().mockResolvedValue({
			agent: 'worker',
			agentSource: 'user',
			task: 'x',
			exitCode: 0,
			messages: [],
			stderr: '',
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			label: 'worker-1',
			...(report ? { report } : {}),
		}),
		runReusedAgent: vi.fn(),
	}));
}

describe('report delivery', () => {
	it('delivers the digest and the report path instead of the full report', async () => {
		mockRunWithReport({
			digest: 'digest body',
			tokens: 4000,
			digestTokens: 500,
			truncated: true,
			ledgerParsed: true,
			path: '/tmp/flow/reports/worker-1-1.md',
		});
		const result = await execSubagent({ agent: 'worker', task: 'x' });
		expect(result.content[0]).toMatchObject({
			text: expect.stringContaining('digest body'),
		});
		expect(result.content[0]).toMatchObject({
			text: expect.stringContaining('[full report: /tmp/flow/reports/worker-1-1.md]'),
		});
		expect(result.content[0]).toMatchObject({
			text: expect.stringContaining('reuseLabel: worker-1'),
		});
		expect(result.content[0]).toMatchObject({
			text: expect.not.stringContaining('Report contract'),
		});
	});

	it('flags a report without a ledger block by default', async () => {
		mockRunWithReport({
			digest: 'status only',
			tokens: 900,
			digestTokens: 120,
			truncated: false,
			ledgerParsed: false,
		});
		const result = await execSubagent({ agent: 'worker', task: 'x' });
		expect(result.content[0]).toMatchObject({
			text: expect.stringContaining('Report contract: no ledger block parsed'),
		});
	});

	it('names a contract failure when the policy rejects', async () => {
		writeConfig({ reportContractPolicy: 'reject' });
		mockRunWithReport({
			digest: 'status only',
			tokens: 900,
			digestTokens: 120,
			truncated: false,
			ledgerParsed: false,
		});
		const result = await execSubagent({ agent: 'worker', task: 'x' });
		expect(result.content[0]).toMatchObject({
			text: expect.stringContaining('Report contract FAILED'),
		});
	});

	it('does not police a short acknowledgement', async () => {
		mockRunWithReport({
			digest: 'digests verified',
			tokens: 5,
			digestTokens: 5,
			truncated: false,
			ledgerParsed: false,
		});
		const result = await execSubagent({ agent: 'worker', task: 'x' });
		expect(result.content[0]).toMatchObject({
			text: expect.stringContaining('digests verified'),
		});
		expect(result.content[0]).toMatchObject({
			text: expect.not.stringContaining('Report contract'),
		});
	});

	it('falls back to the raw output when no report was built', async () => {
		mockRunWithReport();
		const result = await execSubagent({ agent: 'worker', task: 'x' });
		expect(result.content[0]).toMatchObject({
			text: expect.stringContaining('(no output)'),
		});
	});
});
