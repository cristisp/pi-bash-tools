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
import { DEFAULT_CONFIG, getConfig } from '../src/config.ts';
import { PRESET_ENTRY_TYPE } from '../src/presets.ts';
import { makeRegistryEntry, makeTempDir, stubEnv } from './helpers.ts';

let dir: string;

function mockPi() {
	const pi = {
		on: vi.fn(),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		appendEntry: vi.fn(),
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
	return {
		hasUI: true,
		ui: { input, confirm, notify, setStatus: vi.fn() },
		modelRegistry: { find: (): unknown => ({}) },
	};
}

function selectCtx(custom: unknown, overrides: Record<string, unknown> = {}) {
	return {
		hasUI: true,
		ui: { custom, notify: vi.fn(), setStatus: vi.fn() },
		modelRegistry: { find: () => ({}) },
		sessionManager: { getSessionFile: () => '/sess/a.jsonl', getEntries: () => [] },
		...overrides,
	};
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
		expect(commandNames).toEqual([
			'setup-subagents',
			'select-subagent-preset',
			'create-subagent-preset',
			'kill-session-subagents',
		]);

		const events = pi.on.mock.calls.map((c) => c[0]);
		expect(events).toContain('session_start');
		expect(events).toContain('input');
		expect(events.filter((e) => e === 'session_start')).toHaveLength(2);
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
		expect(input).toHaveBeenCalledTimes(2);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining('Invalid model "not a model"'),
			'warning',
		);
		expect(notify).toHaveBeenCalledWith('/setup-subagents canceled', 'info');
	});

	it('setup-subagents aborts when the model stays invalid', async () => {
		const cmd = await getCommand('setup-subagents');
		const input = vi.fn().mockResolvedValue('nope');
		const notify = vi.fn();
		const ctx = setupCtx(input, vi.fn(), notify);
		await cmd.handler({}, ctx);
		expect(input).toHaveBeenCalledTimes(3);
		expect(notify).toHaveBeenCalledWith('/setup-subagents aborted: invalid model spec', 'error');
		expect(notify).not.toHaveBeenCalledWith('/setup-subagents canceled', 'info');
	});

	it('setup-subagents rejects models missing from the registry and aborts after retries', async () => {
		const cmd = await getCommand('setup-subagents');
		const input = vi.fn().mockResolvedValue('p/missing:high');
		const notify = vi.fn();
		const ctx = setupCtx(input, vi.fn(), notify);
		ctx.modelRegistry = { find: () => undefined };
		await cmd.handler({}, ctx);
		expect(input).toHaveBeenCalledTimes(3);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining('Model "p/missing:high" is not available in pi'),
			'warning',
		);
		expect(notify).toHaveBeenCalledWith('/setup-subagents aborted: invalid model spec', 'error');
		expect(fs.existsSync(path.join(dir, 'subagent-herdr.config.json'))).toBe(false);
	});

	it('setup-subagents accepts registry-resolvable models and writes them', async () => {
		const cmd = await getCommand('setup-subagents');
		const input = vi.fn().mockResolvedValue('prov/model-x:high');
		const notify = vi.fn();
		const ctx = setupCtx(input, vi.fn(), notify);
		await cmd.handler({}, ctx);
		const configFile = path.join(dir, 'subagent-herdr.config.json');
		const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
		expect(raw.modelPresets.default.planner).toBe('prov/model-x:high');
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('Config file created'), 'info');
	});

	it('setup-subagents requires a reasoning level and warns without one', async () => {
		const cmd = await getCommand('setup-subagents');
		const input = vi.fn().mockResolvedValueOnce('p/m').mockResolvedValue('p/m:high');
		const notify = vi.fn();
		const ctx = setupCtx(input, vi.fn(), notify);
		await cmd.handler({}, ctx);
		expect(input).toHaveBeenCalledTimes(6);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('Invalid model "p/m"'), 'warning');
		const configFile = path.join(dir, 'subagent-herdr.config.json');
		const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
		expect(raw.modelPresets.default.planner).toBe('p/m:high');
	});

	it('setup-subagents prompts for each standard agent and writes per-agent models', async () => {
		const cmd = await getCommand('setup-subagents');
		const modelsByAgent: Record<string, string> = {
			planner: 'p/planner:high',
			reviewer: 'p/reviewer:high',
			scout: 'p/scout:low',
			worker: 'p/worker:medium',
			validator: 'p/validator:medium',
		};
		const prompted: string[] = [];
		const input = vi.fn((title: string) => {
			for (const agent of Object.keys(modelsByAgent)) {
				if (title.includes(`Model for ${agent}`)) {
					prompted.push(agent);
					return Promise.resolve(modelsByAgent[agent]);
				}
			}
			return Promise.resolve('');
		});
		const notify = vi.fn();
		const ctx = setupCtx(input, vi.fn(), notify);
		await cmd.handler({}, ctx);
		expect(prompted).toEqual(['planner', 'reviewer', 'scout', 'worker', 'validator']);
		const configFile = path.join(dir, 'subagent-herdr.config.json');
		const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
		expect(raw.modelPresets.default).toEqual(modelsByAgent);
		expect(raw.defaultPreset).toBe('default');
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

	it('setup-subagents creates agent files without model frontmatter and seeds the default preset', async () => {
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
		expect(fs.existsSync(path.join(agentsDir, 'validator.md'))).toBe(true);
		const worker = fs.readFileSync(path.join(agentsDir, 'worker.md'), 'utf-8');
		expect(worker).not.toContain('model:');
		const configFile = path.join(dir, 'subagent-herdr.config.json');
		expect(fs.existsSync(configFile)).toBe(true);
		expect(JSON.parse(fs.readFileSync(configFile, 'utf-8'))).toEqual({
			...DEFAULT_CONFIG,
			modelPresets: {
				default: {
					planner: 'github-copilot/gpt-5.6-luna:high',
					reviewer: 'github-copilot/gpt-5.6-luna:high',
					scout: 'github-copilot/gpt-5.6-luna:high',
					worker: 'github-copilot/gpt-5.6-luna:high',
					validator: 'github-copilot/gpt-5.6-luna:high',
				},
			},
			defaultPreset: 'default',
		});
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('5 created'), 'info');
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('Config file created'), 'info');
	});

	it('setup-subagents asks before overriding existing presets and preserves the rest', async () => {
		const configFile = path.join(dir, 'subagent-herdr.config.json');
		fs.writeFileSync(
			configFile,
			JSON.stringify({
				maxParallelTasks: 3,
				modelPresets: {
					cheap: { worker: 'p/m:low' },
					default: { planner: 'old/p:low', worker: 'old/p:low' },
				},
				defaultPreset: 'cheap',
			}),
		);
		const cmd = await getCommand('setup-subagents');
		const input = vi.fn().mockResolvedValue('p/new:high');
		const confirm = vi.fn().mockResolvedValue(true);
		const notify = vi.fn();
		const ctx = setupCtx(input, confirm, notify);
		await cmd.handler({}, ctx);
		expect(confirm).toHaveBeenCalledWith(
			'Update the "default" preset?',
			expect.stringContaining('already defines model presets: cheap, default'),
		);
		const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
		expect(raw.maxParallelTasks).toBe(3);
		expect(raw.defaultPreset).toBe('cheap');
		expect(raw.modelPresets.cheap).toEqual({ worker: 'p/m:low' });
		expect(raw.modelPresets.default).toEqual({
			planner: 'p/new:high',
			reviewer: 'p/new:high',
			scout: 'p/new:high',
			worker: 'p/new:high',
			validator: 'p/new:high',
		});
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining('"default" preset updated'),
			'info',
		);
	});

	it('setup-subagents skips model prompts when the override is declined', async () => {
		const configFile = path.join(dir, 'subagent-herdr.config.json');
		fs.writeFileSync(
			configFile,
			JSON.stringify({ maxParallelTasks: 3, modelPresets: { cheap: { worker: 'p/m:low' } } }),
		);
		const cmd = await getCommand('setup-subagents');
		const input = vi.fn().mockResolvedValue('p/m:off');
		const confirm = vi.fn().mockResolvedValue(false);
		const notify = vi.fn();
		const ctx = setupCtx(input, confirm, notify);
		await cmd.handler({}, ctx);
		expect(input).not.toHaveBeenCalled();
		expect(fs.readFileSync(configFile, 'utf-8')).toBe(
			JSON.stringify({ maxParallelTasks: 3, modelPresets: { cheap: { worker: 'p/m:low' } } }),
		);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('presets left unchanged'), 'info');
	});

	it('setup-subagents reports an invalid config file instead of clobbering it', async () => {
		const configFile = path.join(dir, 'subagent-herdr.config.json');
		fs.writeFileSync(configFile, '{ not json');
		const cmd = await getCommand('setup-subagents');
		const input = vi.fn().mockResolvedValue('p/m:off');
		const notify = vi.fn();
		const ctx = setupCtx(input, vi.fn(), notify);
		await cmd.handler({}, ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('Could not update'), 'info');
		expect(fs.readFileSync(configFile, 'utf-8')).toBe('{ not json');
	});

	it('setup-subagents seeds a legacy config that has no presets yet', async () => {
		const configFile = path.join(dir, 'subagent-herdr.config.json');
		fs.writeFileSync(configFile, JSON.stringify({ maxParallelTasks: 3 }));
		const cmd = await getCommand('setup-subagents');
		const input = vi.fn().mockResolvedValue('p/m:off');
		const notify = vi.fn();
		const ctx = setupCtx(input, vi.fn(), notify);
		await cmd.handler({}, ctx);
		const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
		expect(raw.maxParallelTasks).toBe(3);
		expect(raw.defaultPreset).toBe('default');
		expect(raw.modelPresets.default).toMatchObject({ planner: 'p/m:off', worker: 'p/m:off' });
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining('seeded with default preset'),
			'info',
		);
	});

	it('setup-subagents drops __proto__ presets when updating the default preset', async () => {
		const configFile = path.join(dir, 'subagent-herdr.config.json');
		fs.writeFileSync(
			configFile,
			'{"modelPresets":{"__proto__":{"worker":"p/evil:high"},"cheap":{"worker":"p/m:low"}},"defaultPreset":"cheap"}',
		);
		const cmd = await getCommand('setup-subagents');
		const input = vi.fn().mockResolvedValue('p/new:high');
		const confirm = vi.fn().mockResolvedValue(true);
		const notify = vi.fn();
		const ctx = setupCtx(input, confirm, notify);
		await cmd.handler({}, ctx);
		const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
		expect(Object.keys(raw.modelPresets).toSorted()).toEqual(['cheap', 'default']);
		expect(raw.modelPresets.cheap).toEqual({ worker: 'p/m:low' });
		expect(raw.modelPresets.default).toMatchObject({ planner: 'p/new:high' });
		expect(raw.defaultPreset).toBe('cheap');
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
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('4 created, 1 updated'), 'info');
	});
});

describe('commands - select-subagent-preset', () => {
	const writePresetConfig = (): void => {
		fs.writeFileSync(
			path.join(dir, 'subagent-herdr.config.json'),
			JSON.stringify({
				modelPresets: {
					cheap: { worker: 'p/m:low' },
					deep: { worker: 'p/m:high', reviewer: 'p/n:high' },
				},
				defaultPreset: 'cheap',
			}),
		);
	};

	async function getSelectCommand() {
		const { default: register } = await loadIndex();
		const pi = mockPi();
		register(pi as never);
		const cmd = pi.registerCommand.mock.calls.find((c) => c[0] === 'select-subagent-preset');
		expect(cmd).toBeDefined();
		return { cmd: cmd![1], pi };
	}

	it('warns without UI', async () => {
		const { cmd } = await getSelectCommand();
		const ctx = { hasUI: false, ui: { notify: vi.fn() } };
		await cmd.handler({}, ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			'/select-subagent-preset needs an interactive session',
			'warning',
		);
	});

	it('warns when no presets are configured', async () => {
		const { cmd } = await getSelectCommand();
		const ctx = selectCtx(vi.fn());
		await cmd.handler({}, ctx);
		expect(ctx.ui.custom).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining('No subagent model presets configured'),
			'warning',
		);
	});

	it('shows one item per preset plus the revert option and appends the selection', async () => {
		writePresetConfig();
		const { cmd, pi } = await getSelectCommand();
		const custom = vi.fn().mockResolvedValue('deep');
		const ctx = selectCtx(custom);
		await cmd.handler({}, ctx);
		expect(pi.appendEntry).toHaveBeenCalledWith(PRESET_ENTRY_TYPE, { preset: 'deep' });
		expect(ctx.ui.notify).toHaveBeenCalledWith('Subagent preset for this session: deep', 'info');
		const { presetSelectItems } = await import('../src/commands.ts');
		const items = presetSelectItems(getConfig(), undefined);
		expect(items.map((i) => i.value)).toEqual(['cheap', 'deep', '(use config default)']);
		expect(items[1].description).toBe('[worker: p/m:high, reviewer: p/n:high]');
		expect(items[2].description).toBe('[worker: p/m:low]');
	});

	it('marks the active and default presets in labels', async () => {
		writePresetConfig();
		const { cmd } = await getSelectCommand();
		const custom = vi.fn().mockResolvedValue(null);
		const ctx = selectCtx(custom, {
			sessionManager: {
				getSessionFile: () => '/sess/a.jsonl',
				getEntries: () => [
					{ type: 'custom', customType: PRESET_ENTRY_TYPE, data: { preset: 'deep' } },
				],
			},
		});
		await cmd.handler({}, ctx);
		const { presetSelectItems } = await import('../src/commands.ts');
		const items = presetSelectItems(getConfig(), 'deep');
		const deep = items.find((i) => i.value === 'deep')!;
		const cheap = items.find((i) => i.value === 'cheap')!;
		expect(deep.label).toBe('deep (active)');
		expect(cheap.label).toBe('cheap [default]');
	});

	it('appends a null preset when reverting to the config default', async () => {
		writePresetConfig();
		const { cmd, pi } = await getSelectCommand();
		const custom = vi.fn().mockResolvedValue('(use config default)');
		const ctx = selectCtx(custom);
		await cmd.handler({}, ctx);
		expect(pi.appendEntry).toHaveBeenCalledWith(PRESET_ENTRY_TYPE, { preset: null });
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			'Subagent preset cleared for this session - using config default "cheap"',
			'info',
		);
	});

	it('does nothing when the dialog is canceled', async () => {
		writePresetConfig();
		const { cmd, pi } = await getSelectCommand();
		const custom = vi.fn().mockResolvedValue(null);
		const ctx = selectCtx(custom);
		await cmd.handler({}, ctx);
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it('updates the status bar after selecting and after reverting', async () => {
		writePresetConfig();
		const { cmd } = await getSelectCommand();
		const custom = vi.fn().mockResolvedValue('deep');
		const ctx = selectCtx(custom);
		await cmd.handler({}, ctx);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith('subagent-preset', 'subagent preset: deep');

		const revert = vi.fn().mockResolvedValue('(use config default)');
		const revertCtx = selectCtx(revert);
		await cmd.handler({}, revertCtx);
		expect(revertCtx.ui.setStatus).toHaveBeenCalledWith(
			'subagent-preset',
			'subagent preset: cheap',
		);
	});
});

describe('commands - create-subagent-preset', () => {
	function writeAgent(name: string): void {
		const agentsDir = path.join(dir, 'agents');
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentsDir, `${name}.md`),
			`---\nname: ${name}\ndescription: ${name} agent\n---\n\nPrompt for ${name}.`,
		);
	}

	function createCtx(input: unknown, confirm = vi.fn(), notify = vi.fn()) {
		return {
			hasUI: true,
			cwd: dir,
			ui: { input, confirm, notify },
			modelRegistry: { find: (): unknown => ({}) },
			sessionManager: { getSessionFile: () => '/sess/a.jsonl', getEntries: () => [] },
		};
	}

	async function getCreateCommand() {
		const { default: register } = await loadIndex();
		const pi = mockPi();
		register(pi as never);
		const cmd = pi.registerCommand.mock.calls.find((c) => c[0] === 'create-subagent-preset');
		expect(cmd).toBeDefined();
		return { cmd: cmd![1], pi };
	}

	it('warns without UI', async () => {
		const { cmd } = await getCreateCommand();
		const ctx = { hasUI: false, ui: { notify: vi.fn() } };
		await cmd.handler({}, ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			'/create-subagent-preset needs an interactive session',
			'warning',
		);
	});

	it('warns when no agents are discovered', async () => {
		const { cmd } = await getCreateCommand();
		const ctx = createCtx(vi.fn());
		await cmd.handler({}, ctx);
		expect(ctx.ui.input).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining('No agents found for agentScope "user"'),
			'warning',
		);
	});

	it('prompts per discovered agent, skips blanks, and writes the preset', async () => {
		writeAgent('reviewer');
		writeAgent('worker');
		const { cmd, pi } = await getCreateCommand();
		const prompted: string[] = [];
		const input = vi.fn((title: string) => {
			if (title === 'Preset name') return Promise.resolve('cheap');
			prompted.push(title);
			if (title.includes('reviewer')) return Promise.resolve('p/r:high');
			return Promise.resolve('');
		});
		const notify = vi.fn();
		const ctx = createCtx(input, vi.fn(), notify);
		await cmd.handler({}, ctx);
		expect(prompted).toEqual([
			'Model for reviewer (provider/model:thinking_level) - empty to skip',
			'Model for worker (provider/model:thinking_level) - empty to skip',
		]);
		expect(pi.appendEntry).not.toHaveBeenCalled();
		const configFile = path.join(dir, 'subagent-herdr.config.json');
		const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
		expect(raw.modelPresets).toEqual({ cheap: { reviewer: 'p/r:high' } });
		expect(raw.defaultPreset).toBeUndefined();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining('Preset "cheap" created [reviewer: p/r:high]'),
			'info',
		);
	});

	it('rejects specs without a thinking level and retries', async () => {
		writeAgent('worker');
		const { cmd } = await getCreateCommand();
		const input = vi.fn((title: string) => {
			if (title === 'Preset name') return Promise.resolve('cheap');
			if (title.includes('worker')) return Promise.resolve('p/w');
			return Promise.resolve('');
		});
		const notify = vi.fn();
		const ctx = createCtx(input, vi.fn(), notify);
		await cmd.handler({}, ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('Invalid model "p/w"'), 'warning');
		expect(notify).toHaveBeenCalledWith(
			'/create-subagent-preset aborted: invalid model spec',
			'error',
		);
		expect(fs.existsSync(path.join(dir, 'subagent-herdr.config.json'))).toBe(false);
	});

	it('rejects the reserved __proto__ preset name before prompting for models', async () => {
		writeAgent('worker');
		const { cmd } = await getCreateCommand();
		const input = vi.fn().mockResolvedValue('__proto__');
		const notify = vi.fn();
		const ctx = createCtx(input, vi.fn(), notify);
		await cmd.handler({}, ctx);
		expect(notify).toHaveBeenCalledWith(
			'/create-subagent-preset aborted: "__proto__" is a reserved preset name',
			'error',
		);
		expect(fs.existsSync(path.join(dir, 'subagent-herdr.config.json'))).toBe(false);
	});

	it('rejects models missing from the registry and writes nothing', async () => {
		writeAgent('worker');
		const { cmd } = await getCreateCommand();
		const input = vi.fn((title: string) =>
			Promise.resolve(title === 'Preset name' ? 'cheap' : 'p/gone:high'),
		);
		const notify = vi.fn();
		const ctx = createCtx(input, vi.fn(), notify);
		ctx.modelRegistry = { find: () => undefined };
		await cmd.handler({}, ctx);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining('Model "p/gone:high" is not available in pi'),
			'warning',
		);
		expect(notify).toHaveBeenCalledWith(
			'/create-subagent-preset aborted: invalid model spec',
			'error',
		);
		expect(fs.existsSync(path.join(dir, 'subagent-herdr.config.json'))).toBe(false);
	});

	it('drops __proto__ presets from the config when creating a preset', async () => {
		writeAgent('worker');
		const configFile = path.join(dir, 'subagent-herdr.config.json');
		fs.writeFileSync(
			configFile,
			'{"modelPresets":{"__proto__":{"worker":"p/evil:high"},"keep":{"worker":"p/ok:low"}}}',
		);
		const { cmd } = await getCreateCommand();
		const input = vi.fn((title: string) => {
			if (title === 'Preset name') return Promise.resolve('fresh');
			return Promise.resolve('p/w:high');
		});
		const notify = vi.fn();
		const ctx = createCtx(input, vi.fn(), notify);
		await cmd.handler({}, ctx);
		const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
		expect(Object.keys(raw.modelPresets).toSorted()).toEqual(['fresh', 'keep']);
		expect(raw.modelPresets.keep).toEqual({ worker: 'p/ok:low' });
		expect(raw.modelPresets.fresh).toEqual({ worker: 'p/w:high' });
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining('Preset "fresh" created [worker: p/w:high]'),
			'info',
		);
	});

	it('fails open when no registry is available', async () => {
		writeAgent('worker');
		const { cmd } = await getCreateCommand();
		const input = vi.fn((title: string) =>
			Promise.resolve(title === 'Preset name' ? 'cheap' : 'p/anything:high'),
		);
		const notify = vi.fn();
		const ctx = createCtx(input, vi.fn(), notify);
		delete (ctx as Record<string, unknown>).modelRegistry;
		await cmd.handler({}, ctx);
		const raw = JSON.parse(fs.readFileSync(path.join(dir, 'subagent-herdr.config.json'), 'utf-8'));
		expect(raw.modelPresets.cheap).toEqual({ worker: 'p/anything:high' });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('Preset "cheap" created'), 'info');
	});

	it('aborts when every agent is skipped', async () => {
		writeAgent('worker');
		const { cmd } = await getCreateCommand();
		const input = vi.fn((title: string) => Promise.resolve(title === 'Preset name' ? 'cheap' : ''));
		const notify = vi.fn();
		const ctx = createCtx(input, vi.fn(), notify);
		await cmd.handler({}, ctx);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining('no models entered - preset not created'),
			'warning',
		);
		expect(fs.existsSync(path.join(dir, 'subagent-herdr.config.json'))).toBe(false);
	});

	it('asks before overwriting an existing preset and preserves others', async () => {
		writeAgent('worker');
		const configFile = path.join(dir, 'subagent-herdr.config.json');
		fs.writeFileSync(
			configFile,
			JSON.stringify({
				modelPresets: { cheap: { worker: 'p/old:low' }, deep: { worker: 'p/d:high' } },
			}),
		);
		const { cmd } = await getCreateCommand();
		const input = vi.fn((title: string) =>
			Promise.resolve(title === 'Preset name' ? 'cheap' : 'p/new:low'),
		);
		const confirm = vi.fn().mockResolvedValue(true);
		const ctx = createCtx(input, confirm);
		await cmd.handler({}, ctx);
		expect(confirm).toHaveBeenCalledWith(
			'Overwrite preset?',
			expect.stringContaining('already exists'),
		);
		const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
		expect(raw.modelPresets.cheap).toEqual({ worker: 'p/new:low' });
		expect(raw.modelPresets.deep).toEqual({ worker: 'p/d:high' });
	});

	it('keeps the existing preset when the overwrite is declined', async () => {
		writeAgent('worker');
		const configFile = path.join(dir, 'subagent-herdr.config.json');
		fs.writeFileSync(
			configFile,
			JSON.stringify({ modelPresets: { cheap: { worker: 'p/old:low' } } }),
		);
		const { cmd } = await getCreateCommand();
		const input = vi.fn((title: string) =>
			Promise.resolve(title === 'Preset name' ? 'cheap' : 'p/new:low'),
		);
		const confirm = vi.fn().mockResolvedValue(false);
		const ctx = createCtx(input, confirm);
		await cmd.handler({}, ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			'/create-subagent-preset canceled - existing preset kept',
			'info',
		);
		expect(fs.readFileSync(configFile, 'utf-8')).toBe(
			JSON.stringify({ modelPresets: { cheap: { worker: 'p/old:low' } } }),
		);
	});

	it('cancels when the name prompt is dismissed', async () => {
		writeAgent('worker');
		const { cmd } = await getCreateCommand();
		const input = vi.fn().mockResolvedValue(undefined);
		const ctx = createCtx(input);
		await cmd.handler({}, ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith('/create-subagent-preset canceled', 'info');
		expect(fs.existsSync(path.join(dir, 'subagent-herdr.config.json'))).toBe(false);
	});

	it('aborts when the preset name stays empty', async () => {
		writeAgent('worker');
		const { cmd } = await getCreateCommand();
		const input = vi.fn().mockResolvedValue('   ');
		const ctx = createCtx(input);
		await cmd.handler({}, ctx);
		expect(input).toHaveBeenCalledTimes(3);
		expect(ctx.ui.notify).toHaveBeenCalledWith('Preset name cannot be empty', 'warning');
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			'/create-subagent-preset aborted: no preset name',
			'error',
		);
		expect(fs.existsSync(path.join(dir, 'subagent-herdr.config.json'))).toBe(false);
	});

	it('reports an invalid config file instead of clobbering it', async () => {
		writeAgent('worker');
		const configFile = path.join(dir, 'subagent-herdr.config.json');
		fs.writeFileSync(configFile, '{ not json');
		const { cmd } = await getCreateCommand();
		const input = vi.fn((title: string) =>
			Promise.resolve(title === 'Preset name' ? 'cheap' : 'p/w:low'),
		);
		const ctx = createCtx(input);
		await cmd.handler({}, ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining('Could not update'),
			'error',
		);
		expect(fs.readFileSync(configFile, 'utf-8')).toBe('{ not json');
	});
});

function statusCtx(entries: unknown[] = [], overrides: Record<string, unknown> = {}) {
	return {
		hasUI: true,
		ui: { setStatus: vi.fn(), notify: vi.fn() },
		modelRegistry: { find: () => ({}) },
		sessionManager: { getSessionFile: () => '/sess/a.jsonl', getEntries: () => entries },
		...overrides,
	};
}

describe('commands - subagent preset status bar', () => {
	async function getSessionStartHandlers() {
		const { default: register } = await loadIndex();
		const pi = mockPi();
		register(pi as never);
		const handlers = pi.on.mock.calls.filter((c) => c[0] === 'session_start').map((c) => c[1]);
		expect(handlers.length).toBeGreaterThan(0);
		return handlers;
	}

	function writePresetConfig(): void {
		fs.writeFileSync(
			path.join(dir, 'subagent-herdr.config.json'),
			JSON.stringify({
				modelPresets: { cheap: { worker: 'p/m:low' }, deep: { worker: 'p/m:high' } },
				defaultPreset: 'cheap',
			}),
		);
	}

	function writeStalePresetConfig(): void {
		fs.writeFileSync(
			path.join(dir, 'subagent-herdr.config.json'),
			JSON.stringify({
				modelPresets: {
					cheap: { worker: 'p/ok:low' },
					stale: { worker: 'p/gone:high', scout: 'p/also-gone:low' },
				},
				defaultPreset: 'cheap',
			}),
		);
	}

	it('shows the effective preset on session start', async () => {
		writePresetConfig();
		const handlers = await getSessionStartHandlers();
		const ctx = statusCtx();
		for (const handler of handlers) await handler({}, ctx);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith('subagent-preset', 'subagent preset: cheap');
	});

	it('prefers the session override over the config default', async () => {
		writePresetConfig();
		const handlers = await getSessionStartHandlers();
		const ctx = statusCtx([
			{ type: 'custom', customType: PRESET_ENTRY_TYPE, data: { preset: 'deep' } },
		]);
		for (const handler of handlers) await handler({}, ctx);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith('subagent-preset', 'subagent preset: deep');
	});

	it('clears the status when no preset is effective', async () => {
		const handlers = await getSessionStartHandlers();
		const ctx = statusCtx();
		for (const handler of handlers) await handler({}, ctx);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith('subagent-preset', undefined);
	});

	it('does not touch the status without UI', async () => {
		writePresetConfig();
		const handlers = await getSessionStartHandlers();
		const ctx = statusCtx([], { hasUI: false });
		for (const handler of handlers) await handler({}, ctx);
		expect(ctx.ui.setStatus).not.toHaveBeenCalled();
	});

	it('warns about preset models missing from the registry on session start', async () => {
		writeStalePresetConfig();
		const handlers = await getSessionStartHandlers();
		const ctx = statusCtx([], {
			modelRegistry: {
				find: (_p: string, modelId: string) => (modelId.includes('gone') ? undefined : {}),
			},
		});
		for (const handler of handlers) await handler({}, ctx);
		const warnings = ctx.ui.notify.mock.calls.filter((c: unknown[]) => c[1] === 'warning');
		expect(warnings).toHaveLength(1);
		const text = warnings[0][0] as string;
		expect(text).toContain('Some subagent preset models are not available in pi');
		expect(text).toContain('- "stale": [worker: p/gone:high, scout: p/also-gone:low]');
		expect(text).not.toContain('"cheap"');
		expect(text).toContain('Update modelPresets in');
		expect(ctx.ui.setStatus).toHaveBeenCalledWith('subagent-preset', 'subagent preset: cheap');
	});

	it('does not warn when all preset models resolve, even without a registry', async () => {
		writePresetConfig();
		const handlers = await getSessionStartHandlers();
		const ctx = statusCtx([], { modelRegistry: undefined });
		for (const handler of handlers) await handler({}, ctx);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(ctx.ui.setStatus).toHaveBeenCalledWith('subagent-preset', 'subagent preset: cheap');
	});
});
