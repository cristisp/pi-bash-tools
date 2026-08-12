import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('../src/herdr.ts', async (importOriginal) => {
	const mod = await importOriginal<typeof import('../src/herdr.ts')>();
	return {
		...mod,
		closeTab: vi.fn(),
		getAgentStatus: vi.fn(),
	};
});

import { closeTab, getAgentStatus } from '../src/herdr.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { makeRegistryEntry, makeTempDir, stubEnv } from './helpers.ts';

let dir: string;

function mockPi() {
	const pi = {
		on: vi.fn(),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
	};
	return pi;
}

async function loadIndex() {
	vi.resetModules();
	return import('../index.ts');
}

function handlerCtx(overrides: Record<string, unknown> = {}) {
	return {
		sessionManager: { getSessionFile: () => '/sess/a.jsonl' },
		ui: { notify: vi.fn() },
		...overrides,
	};
}

function setupCtx(input: unknown, confirm: unknown = vi.fn(), notify = vi.fn()) {
	return { hasUI: true, ui: { input, confirm, notify } };
}

beforeEach(() => {
	vi.resetModules();
	dir = makeTempDir();
	stubEnv(dir);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

describe('extension registration', () => {
	it('registers tools, commands, and handlers when herdr env is present', async () => {
		const { default: register } = await loadIndex();
		const pi = mockPi();
		register(pi as never);

		const toolNames = pi.registerTool.mock.calls.map((c) => c[0].name);
		expect(toolNames.toSorted()).toEqual(['subagent', 'subagent_close', 'subagent_stats']);

		const commandNames = pi.registerCommand.mock.calls.map((c) => c[0]);
		expect(commandNames).toEqual(['setup-subagents', 'kill-session-subagents']);

		const events = pi.on.mock.calls.map((c) => c[0]);
		expect(events).toContain('session_start');
		expect(events).toContain('input');
	});

	it('registers the explicit list, stats, and reuse guidance', async () => {
		const { default: register } = await loadIndex();
		const pi = mockPi();
		register(pi as never);

		const subagent = pi.registerTool.mock.calls.find((c) => c[0].name === 'subagent')![0];
		const stats = pi.registerTool.mock.calls.find((c) => c[0].name === 'subagent_stats')![0];
		expect(subagent.description).toContain('call subagent with listSubagents: true');
		expect(subagent.description).toContain('call subagent_stats with that label');
		expect(subagent.description).toContain('Never infer or increment labels');
		expect(subagent.description).toContain('another workspace');
		expect(subagent.description).toContain('workspace:label');
		expect(stats.description).toContain('This tool is the stats step and must run before reuse');
		expect(stats.description).toContain('Never infer or increment labels');
	});
});

describe('subagent_stats tool - ownership', () => {
	async function getStatsTool() {
		const { default: register } = await loadIndex();
		const pi = mockPi();
		register(pi as never);
		const tool = pi.registerTool.mock.calls.find((c) => c[0].name === 'subagent_stats');
		expect(tool).toBeDefined();
		return tool![0];
	}

	it('fails closed without looking up a same-workspace entry when the session file is missing', async () => {
		const { registerEntry } = await import('../src/registry.ts');
		const { readRegistry } = await import('../src/registry-store.ts');
		registerEntry(makeRegistryEntry({ parentSession: '/sess/other.jsonl' }));
		const before = readRegistry();
		const tool = await getStatsTool();
		const out = await tool.execute('stats-1', { label: 'worker-1' }, undefined, undefined, {
			...handlerCtx(),
			sessionManager: { getSessionFile: () => undefined },
		});
		expect(out.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('session ownership is unavailable'),
		});
		expect(out.content[0]).toMatchObject({
			type: 'text',
			text: expect.not.stringContaining('Session ws1:worker-1'),
		});
		expect(readRegistry()).toEqual(before);
	});
});

describe('input handler - pass-through', () => {
	async function getInputHandler() {
		const { default: register } = await loadIndex();
		const pi = mockPi();
		register(pi as never);
		const call = pi.on.mock.calls.find((c) => c[0] === 'input');
		expect(call).toBeDefined();
		return call![1];
	}

	it('passes through when no sessions are linked', async () => {
		const handler = await getInputHandler();
		const ctx = handlerCtx();
		const out = await handler({}, ctx);
		expect(out).toEqual({ action: 'continue' });
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it('passes through for running linked sessions', async () => {
		const { registerEntry } = await import('../src/registry.ts');
		registerEntry(makeRegistryEntry({ parentSession: '/sess/a.jsonl', status: 'running' }));
		const handler = await getInputHandler();
		const ctx = handlerCtx();
		const out = await handler({}, ctx);
		expect(out).toEqual({ action: 'continue' });
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});
});

describe('input handler - interception', () => {
	async function getInputHandler() {
		const { default: register } = await loadIndex();
		const pi = mockPi();
		register(pi as never);
		const call = pi.on.mock.calls.find((c) => c[0] === 'input');
		expect(call).toBeDefined();
		return call![1];
	}

	it('passes through while a done session is working again', async () => {
		const { registerEntry } = await import('../src/registry.ts');
		registerEntry(makeRegistryEntry({ parentSession: '/sess/a.jsonl', status: 'done' }));
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'working' });
		const handler = await getInputHandler();
		const ctx = handlerCtx();
		const out = await handler({}, ctx);
		expect(out).toEqual({ action: 'continue' });
	});

	it('intercepts input for read-only done sessions', async () => {
		const { registerEntry } = await import('../src/registry.ts');
		registerEntry(
			makeRegistryEntry({
				parentSession: '/sess/a.jsonl',
				sessionFile: '/sess/a.jsonl',
				status: 'done',
			}),
		);
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'done' });
		const handler = await getInputHandler();
		const ctx = handlerCtx();
		const out = await handler({}, ctx);
		expect(out).toEqual({ action: 'handled' });
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('read-only'), 'warning');
	});
});

describe('subagent_close tool - label handling', () => {
	async function getCloseTool() {
		const { default: register } = await loadIndex();
		const pi = mockPi();
		register(pi as never);
		const tool = pi.registerTool.mock.calls.find((c) => c[0].name === 'subagent_close');
		expect(tool).toBeDefined();
		return tool![0];
	}

	it('reports unknown labels', async () => {
		const tool = await getCloseTool();
		const ctx = handlerCtx();
		const out = await tool.execute('c1', { label: 'ghost-1' }, undefined, undefined, ctx);
		expect(out.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('No session-linked subagent labeled "ghost-1"'),
		});
		expect(closeTab).not.toHaveBeenCalled();
	});

	it('closes a specific linked subagent', async () => {
		const { registerEntry } = await import('../src/registry.ts');
		registerEntry(makeRegistryEntry({ parentSession: '/sess/a.jsonl' }));
		const tool = await getCloseTool();
		const ctx = handlerCtx();
		const out = await tool.execute('c1', { label: 'worker-1' }, undefined, undefined, ctx);
		expect(out.content[0]).toMatchObject({
			type: 'text',
			text: 'Closed 1 subagent(s): ws1:worker-1',
		});
		expect(closeTab).toHaveBeenCalledWith('tab10');
	});
});

describe('subagent_close tool - bulk close', () => {
	async function getCloseTool() {
		const { default: register } = await loadIndex();
		const pi = mockPi();
		register(pi as never);
		const tool = pi.registerTool.mock.calls.find((c) => c[0].name === 'subagent_close');
		expect(tool).toBeDefined();
		return tool![0];
	}

	it('closes all linked subagents without a label', async () => {
		const { registerEntry } = await import('../src/registry.ts');
		registerEntry(makeRegistryEntry({ parentSession: '/sess/a.jsonl' }));
		registerEntry(
			makeRegistryEntry({
				label: 'reviewer-1',
				agent: 'reviewer',
				paneId: 'ws1:p11',
				tabId: 'tab11',
				parentSession: '/sess/a.jsonl',
			}),
		);
		const tool = await getCloseTool();
		const ctx = handlerCtx();
		const out = await tool.execute('c1', {}, undefined, undefined, ctx);
		expect(out.content[0]).toMatchObject({
			type: 'text',
			text: 'Closed 2 subagent(s): ws1:worker-1, ws1:reviewer-1',
		});
		expect(closeTab).toHaveBeenCalledTimes(2);
	});
});

describe('commands - kill', () => {
	async function getCommand(name: string) {
		const { default: register } = await loadIndex();
		const pi = mockPi();
		register(pi as never);
		const cmd = pi.registerCommand.mock.calls.find((c) => c[0] === name);
		expect(cmd).toBeDefined();
		return cmd![1];
	}

	it('kill-session-subagents closes linked sessions and notifies', async () => {
		const { registerEntry } = await import('../src/registry.ts');
		registerEntry(makeRegistryEntry({ parentSession: '/sess/a.jsonl' }));
		const cmd = await getCommand('kill-session-subagents');
		const ctx = handlerCtx();
		await cmd.handler({}, ctx);
		expect(closeTab).toHaveBeenCalledWith('tab10');
		expect(ctx.ui.notify).toHaveBeenCalledWith('Closed 1 subagent(s): ws1:worker-1', 'info');
	});
});

describe('commands - setup warnings and cancel', () => {
	async function getCommand(name: string) {
		const { default: register } = await loadIndex();
		const pi = mockPi();
		register(pi as never);
		const cmd = pi.registerCommand.mock.calls.find((c) => c[0] === name);
		expect(cmd).toBeDefined();
		return cmd![1];
	}

	it('setup-subagents warns without UI', async () => {
		const cmd = await getCommand('setup-subagents');
		const ctx = { hasUI: false, ui: { notify: vi.fn() } };
		await cmd.handler({}, ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			'/setup-subagents needs an interactive session',
			'warning',
		);
	});

	it('setup-subagents retries invalid models and aborts on cancel', async () => {
		const cmd = await getCommand('setup-subagents');
		const input = vi.fn().mockResolvedValueOnce('not a model').mockResolvedValueOnce(undefined);
		const notify = vi.fn();
		const ctx = setupCtx(input, vi.fn(), notify);
		await cmd.handler({}, ctx);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining('Invalid model "not a model"'),
			'warning',
		);
		expect(notify).toHaveBeenCalledWith('/setup-subagents canceled', 'info');
	});

	it('setup-subagents aborts when the model stays invalid', async () => {
		const cmd = await getCommand('setup-subagents');
		const notify = vi.fn();
		const ctx = setupCtx(vi.fn().mockResolvedValue('nope'), vi.fn(), notify);
		await cmd.handler({}, ctx);
		expect(notify).toHaveBeenCalledWith('/setup-subagents aborted: invalid model spec', 'error');
	});
});

describe('commands - setup file creation', () => {
	async function getCommand(name: string) {
		const { default: register } = await loadIndex();
		const pi = mockPi();
		register(pi as never);
		const cmd = pi.registerCommand.mock.calls.find((c) => c[0] === name);
		expect(cmd).toBeDefined();
		return cmd![1];
	}

	it('setup-subagents creates agent files with a valid model', async () => {
		const cmd = await getCommand('setup-subagents');
		const input = vi.fn().mockResolvedValue('github-copilot/gpt-5.6-luna:high');
		const confirm = vi.fn().mockResolvedValue(true);
		const notify = vi.fn();
		const ctx = setupCtx(input, confirm, notify);
		await cmd.handler({}, ctx);
		const agentsDir = path.join(dir, 'agents');
		expect(fs.existsSync(path.join(agentsDir, 'worker.md'))).toBe(true);
		expect(fs.existsSync(path.join(agentsDir, 'planner.md'))).toBe(true);
		expect(fs.existsSync(path.join(agentsDir, 'reviewer.md'))).toBe(true);
		expect(fs.existsSync(path.join(agentsDir, 'scout.md'))).toBe(true);
		const worker = fs.readFileSync(path.join(agentsDir, 'worker.md'), 'utf-8');
		expect(worker).toContain('model: github-copilot/gpt-5.6-luna:high');
		const configFile = path.join(dir, 'subagent-herdr.config.json');
		expect(fs.existsSync(configFile)).toBe(true);
		expect(JSON.parse(fs.readFileSync(configFile, 'utf-8'))).toEqual(DEFAULT_CONFIG);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('4 created'), 'info');
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('Config file created'), 'info');
	});

	it('setup-subagents leaves an existing config file untouched', async () => {
		const configFile = path.join(dir, 'subagent-herdr.config.json');
		fs.writeFileSync(configFile, JSON.stringify({ maxParallelTasks: 3 }));
		const cmd = await getCommand('setup-subagents');
		const notify = vi.fn();
		const ctx = setupCtx(vi.fn().mockResolvedValue('p/m:off'), vi.fn(), notify);
		await cmd.handler({}, ctx);
		expect(fs.readFileSync(configFile, 'utf-8')).toBe(JSON.stringify({ maxParallelTasks: 3 }));
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining('Config file already exists (left unchanged)'),
			'info',
		);
	});
});

describe('commands - setup overwrite', () => {
	async function getCommand(name: string) {
		const { default: register } = await loadIndex();
		const pi = mockPi();
		register(pi as never);
		const cmd = pi.registerCommand.mock.calls.find((c) => c[0] === name);
		expect(cmd).toBeDefined();
		return cmd![1];
	}

	it('setup-subagents overwrites existing files after confirm', async () => {
		const agentsDir = path.join(dir, 'agents');
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, 'worker.md'), 'old');
		const cmd = await getCommand('setup-subagents');
		const confirm = vi.fn().mockResolvedValue(true);
		const notify = vi.fn();
		const ctx = setupCtx(vi.fn().mockResolvedValue('p/m:off'), confirm, notify);
		await cmd.handler({}, ctx);
		expect(confirm).toHaveBeenCalledWith(
			'Overwrite existing agent files?',
			expect.stringContaining('worker.md'),
		);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('3 created, 1 updated'), 'info');
	});
});
