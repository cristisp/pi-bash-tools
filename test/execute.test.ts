import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { SubagentParams } from '../src/execute.ts';
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

async function execSubagent(params: SubagentParams, overrides: Partial<ExtensionContext> = {}) {
	const { executeSubagent } = await loadExecute();
	return executeSubagent(params, undefined, undefined, ctx(overrides));
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
			cwd: '/tmp',
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
	});
});
