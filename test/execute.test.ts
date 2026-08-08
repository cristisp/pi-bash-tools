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
	vi.unstubAllEnvs();
});

function ctx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		cwd: dir,
		hasUI: false,
		sessionManager: { getSessionFile: () => undefined },
		ui: {} as ExtensionContext['ui'],
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
	it('lists agents with name, source, and description', async () => {
		const agentsDir = path.join(dir, 'agents');
		fs.mkdirSync(agentsDir, { recursive: true });
		writeAgentFile(agentsDir, 'worker.md', 'prompt', {
			name: 'worker',
			description: 'executes tasks',
		});
		writeAgentFile(agentsDir, 'reviewer.md', 'prompt', {
			name: 'reviewer',
			description: 'reviews code',
			model: 'test-model',
		});
		const result = await execSubagent({ agents: true });
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('- worker (user) - executes tasks'),
		});
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('- reviewer (user) - reviews code, model: test-model'),
		});
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('do not invent agent names'),
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
		const result = await execSubagent({ reuseLabel: 'worker-1' });
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: 'Invalid parameters. reuseLabel requires a task (the next message for that session).',
		});
	});

	it('reports unknown reuse labels', async () => {
		const result = await execSubagent({ reuseLabel: 'ghost-1', task: 'hi' });
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('No subagent session labeled "ghost-1"'),
		});
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

describe('executeSubagent - listing', () => {
	it('lists subagents without entries', async () => {
		const result = await execSubagent({ listSubagents: true });
		expect(result.content[0]).toMatchObject({ type: 'text', text: 'No subagent sessions yet.' });
	});

	it('lists subagents with filters', async () => {
		await seedRegistry([
			makeRegistryEntry({ status: 'running' }),
			makeRegistryEntry({ label: 'reviewer-1', agent: 'reviewer', status: 'done' }),
		]);
		const result = await execSubagent({ listSubagents: true, listStatus: 'running' });
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('worker-1'),
		});
		expect(result.content[0]).toMatchObject({
			type: 'text',
			text: expect.not.stringContaining('reviewer-1'),
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
