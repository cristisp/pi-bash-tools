import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/herdr.ts', async (importOriginal) => {
	const mod = await importOriginal<typeof import('../src/herdr.ts')>();
	return {
		...mod,
		closeTab: vi.fn(),
		createTaskTab: vi.fn(),
		getAgentStatus: vi.fn(),
		herdrCli: vi.fn(),
		launchInPane: vi.fn(),
		resolveOwnWorkspace: vi.fn(),
		resolveWorkspaceName: vi.fn(),
	};
});

vi.mock('../src/poll.ts', () => ({
	pollSubagent: vi.fn(),
}));

vi.mock('../src/manifest.ts', async (importOriginal) => {
	const mod = await importOriginal<typeof import('../src/manifest.ts')>();
	return { ...mod, writeReadManifest: vi.fn(mod.writeReadManifest) };
});

import {
	closeTab,
	createTaskTab,
	getAgentStatus,
	herdrCli,
	launchInPane,
	resolveOwnWorkspace,
	resolveWorkspaceName,
} from '../src/herdr.ts';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { DEFAULT_CONFIG, configPath, roleBudgetFor } from '../src/config.ts';
import { ledgerPath, parseLedger } from '../src/ledger.ts';
import { writeReadManifest } from '../src/manifest.ts';
import { pollSubagent } from '../src/poll.ts';
import { runReusedAgent, runSingleAgent } from '../src/run.ts';
import { registerEntry } from '../src/registry.ts';
import { readRegistry } from '../src/registry-store.ts';
import { readTelemetryRecords, telemetryPath } from '../src/telemetry.ts';
import { flowReportsDir, flowsRoot } from '../src/flow.ts';
import type { AgentConfig } from '../src/agents.ts';
import type { SingleResult, SubagentDetails } from '../src/types.ts';
import { assistantMsg, makeRegistryEntry, toolResultMsg } from './helpers.ts';

const agent: AgentConfig = {
	name: 'worker',
	description: 'worker agent',
	systemPrompt: 'You are a worker.',
	source: 'user',
	filePath: '/tmp/worker.md',
};

const reviewerAgent: AgentConfig = {
	name: 'reviewer',
	description: 'reviewer agent',
	systemPrompt: 'You are a reviewer.',
	source: 'user',
	filePath: '/tmp/reviewer.md',
};

const validatorAgent: AgentConfig = {
	name: 'validator',
	description: 'validator agent',
	systemPrompt: 'You are a validator.',
	source: 'user',
	filePath: '/tmp/validator.md',
};

function makeDetails(results: SingleResult[]): SubagentDetails {
	return { mode: 'single', agentScope: 'user', projectAgentsDir: null, results };
}

function tempDirs(): string[] {
	try {
		return fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('pi-subagent-'));
	} catch {
		return [];
	}
}

/**
 * Directories created after the snapshot. `test/setup.ts` points TMPDIR at a per-file private root, so
 * this scan sees only this file's prompt dirs: sibling test files run in their own workers with their
 * own roots, and real subagent launches from other pi sessions use the real TMPDIR.
 */
function tempDirsSince(baseline: Set<string>): string[] {
	return tempDirs().filter((dir) => !baseline.has(dir));
}

describe('test harness isolation', () => {
	it('scans a per-file temp root so prompt dirs from sibling files cannot leak in', () => {
		expect(path.basename(fs.realpathSync(os.tmpdir()))).toMatch(/^subagent-herdr-tmp-/);
		expect(fs.realpathSync(process.env.TMPDIR as string)).toBe(fs.realpathSync(os.tmpdir()));
	});
});

function singleCall(
	overrides: {
		agentName?: string;
		task?: string;
		step?: number;
		parentSession?: string;
		agents?: AgentConfig[];
		presetModels?: Record<string, string>;
		orchestration?: Parameters<typeof runSingleAgent>[12];
	} = {},
) {
	return runSingleAgent(
		'/tmp',
		overrides.agents ?? [agent],
		overrides.agentName ?? 'worker',
		overrides.task ?? 'do it',
		undefined,
		overrides.step,
		undefined,
		undefined,
		makeDetails,
		overrides.parentSession,
		undefined,
		overrides.presetModels,
		overrides.orchestration,
	);
}

function reuseCall(
	label = 'worker-1',
	task = 'next task',
	parentSession?: string,
	presetModels?: Record<string, string>,
) {
	return runReusedAgent(
		'/tmp',
		[agent],
		label,
		task,
		undefined,
		undefined,
		makeDetails,
		undefined,
		parentSession,
		presetModels,
	);
}

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	for (const f of ['subagent-herdr.json', 'subagent-herdr.json.lock']) {
		try {
			fs.unlinkSync(path.join(getAgentDir(), f));
		} catch {}
	}
	for (const f of [telemetryPath(), `${telemetryPath()}.lock`]) {
		try {
			fs.unlinkSync(f);
		} catch {}
	}
	try {
		fs.rmSync(flowsRoot(), { recursive: true, force: true });
	} catch {}
	vi.mocked(resolveOwnWorkspace).mockResolvedValue('ws1');
	vi.mocked(resolveWorkspaceName).mockResolvedValue(undefined);
	vi.mocked(createTaskTab).mockResolvedValue({ paneId: 'ws1:p9', tabId: 't9' });
	vi.mocked(launchInPane).mockResolvedValue(null);
	vi.mocked(herdrCli).mockResolvedValue({ result: {} });
	vi.mocked(getAgentStatus).mockResolvedValue({ status: 'working' });
	vi.mocked(pollSubagent).mockResolvedValue('settled');
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('runSingleAgent - launch', () => {
	it('launches, polls, and registers a completed session', async () => {
		vi.mocked(pollSubagent).mockImplementation(async (...args) => {
			args[4].messages.push(
				assistantMsg('done', {
					toolCalls: [
						{ id: 't1', name: 'read', args: { path: 'src/a.ts' } },
						{ id: 't2', name: 'read', args: { path: 'src/a.ts' } },
					],
					usage: { totalTokens: 1200 },
				}),
			);
			args[4].messages.push(toolResultMsg('t1'));
			args[4].messages.push(toolResultMsg('t2'));
			return 'settled';
		});
		const baseline = new Set(tempDirs());
		const result = await singleCall({ step: 1, parentSession: '/sess/parent.jsonl' });
		expect(result.exitCode).toBe(0);
		expect(result.label).toBe('worker-1');
		expect(result.step).toBe(1);
		expect(result.paneId).toBe('ws1:p9');
		expect(result.metrics).toMatchObject({
			toolCalls: 2,
			failedToolCalls: 0,
			repeatedReads: 1,
			messageCount: 3,
			taskChars: 5,
			outputChars: 4,
			maxContextTokens: 1200,
		});
		expect(result.metrics?.durationMs).toBeGreaterThanOrEqual(0);
		expect(createTaskTab).toHaveBeenCalledWith('ws1', '/tmp', 'worker-1');
		expect(launchInPane).toHaveBeenCalledOnce();
		const launchArgs = vi.mocked(launchInPane).mock.calls[0];
		expect(launchArgs[1]).toContain('worker-1');
		expect(launchArgs[1]).toContain('--append-system-prompt');
		expect(pollSubagent).toHaveBeenCalledWith(
			'ws1:p9',
			expect.stringContaining('subagent-ws1-worker-1.jsonl'),
			0,
			undefined,
			result,
			undefined,
			expect.any(Function),
			undefined,
		);
		const reg = readRegistry();
		expect(reg.tabs['ws1:worker-1']).toMatchObject({
			status: 'done',
			agent: 'worker',
			paneId: 'ws1:p9',
			parentSession: '/sess/parent.jsonl',
			tasks: ['do it'],
		});
		expect(tempDirsSince(baseline)).toEqual([]);
	});

	it('persists the workspace display name on a fresh entry', async () => {
		vi.mocked(resolveWorkspaceName).mockResolvedValue('Project Alpha');
		await singleCall({ parentSession: '/sess/parent.jsonl' });
		expect(readRegistry().tabs['ws1:worker-1']).toMatchObject({
			workspace: 'ws1',
			workspaceName: 'Project Alpha',
		});
	});

	it('keeps temp files alive until the run completes', async () => {
		const baseline = new Set(tempDirs());
		let resolvePoll!: (value: 'aborted' | 'gone' | 'settled' | 'failed') => void;
		vi.mocked(pollSubagent).mockReturnValue(
			new Promise<'aborted' | 'gone' | 'settled' | 'failed'>((resolve) => {
				resolvePoll = resolve;
			}),
		);
		const promise = singleCall({ step: 1 });
		await vi.waitFor(() => {
			expect(tempDirsSince(baseline).length).toBeGreaterThan(0);
		});
		resolvePoll('settled');
		const result = await promise;
		expect(result.exitCode).toBe(0);
		expect(tempDirsSince(baseline)).toEqual([]);
	});
});

describe('runSingleAgent - preset model', () => {
	it('uses the preset map model in the launch command and result', async () => {
		const result = await singleCall({ presetModels: { worker: 'p/worker-model:high' } });
		expect(result.model).toBe('p/worker-model:high');
		const launchArgs = vi.mocked(launchInPane).mock.calls[0];
		expect(launchArgs[1]).toContain("--model 'p/worker-model:high'");
	});

	it('omits --model when the preset map has no entry for the agent', async () => {
		const result = await singleCall({
			agentName: 'reviewer',
			agents: [reviewerAgent],
			presetModels: { worker: 'p/worker-model:high' },
		});
		expect(result.model).toBeUndefined();
		const launchArgs = vi.mocked(launchInPane).mock.calls[0];
		expect(launchArgs[1]).not.toContain('--model');
	});

	it('omits --model when no preset map is given', async () => {
		const result = await singleCall();
		expect(result.model).toBeUndefined();
		const launchArgs = vi.mocked(launchInPane).mock.calls[0];
		expect(launchArgs[1]).not.toContain('--model');
	});

	it('ignores inherited properties when the preset map is a plain object', async () => {
		const constructorAgent: AgentConfig = {
			name: 'constructor',
			description: 'oddly named agent',
			systemPrompt: 'You are odd.',
			source: 'user',
			filePath: '/tmp/constructor.md',
		};
		const result = await singleCall({
			agentName: 'constructor',
			agents: [constructorAgent],
			presetModels: {} as Record<string, string>,
		});
		expect(result.model).toBeUndefined();
		const launchArgs = vi.mocked(launchInPane).mock.calls[0];
		expect(launchArgs[1]).not.toContain('--model');
	});

	it('applies the preset model when relaunching a reused session', async () => {
		vi.mocked(herdrCli).mockResolvedValue({ error: { code: 'pane_not_found' } });
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'no-agent' });
		registerEntry(makeRegistryEntry({ status: 'running' }));
		const result = await reuseCall('worker-1', 'next task', undefined, {
			worker: 'p/worker-model:high',
		});
		expect(result.exitCode).toBe(0);
		expect(result.model).toBe('p/worker-model:high');
		expect(vi.mocked(launchInPane).mock.calls[0][1]).toContain("--model 'p/worker-model:high'");
	});
});

describe('runSingleAgent - failures', () => {
	it('persists a lastError when budget enforcement aborts a fresh child', async () => {
		vi.mocked(pollSubagent).mockImplementation(async (...args) => {
			args[4].budget = {
				role: 'worker',
				limits: roleBudgetFor('worker'),
				usage: {
					toolCalls: 25,
					discoveryCalls: 0,
					fullValidationPasses: 0,
					failedToolCalls: 0,
					repeatedReads: 0,
					outputTokens: 0,
					wallTimeMs: 0,
				},
				outcome: 'aborted',
				breaches: [{ metric: 'toolCalls', limit: 24, observed: 25, at: Date.now() }],
				steerIssued: false,
				reportOnly: false,
			};
			return 'aborted';
		});

		await expect(singleCall({ parentSession: '/sess/parent.jsonl' })).rejects.toThrow(
			'Subagent was aborted',
		);
		expect(readRegistry().tabs['ws1:worker-1']).toMatchObject({
			status: 'done',
			lastError: expect.stringContaining('Budget enforcement aborted worker'),
		});
	});

	it('cleans up and unregisters on launch failure', async () => {
		vi.mocked(launchInPane).mockResolvedValue('boom');
		const baseline = new Set(tempDirs());
		const result = await singleCall();
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('Could not launch subagent in pane ws1:p9 (boom)');
		expect(closeTab).toHaveBeenCalledWith('t9');
		expect(readRegistry().tabs).toEqual({});
		expect(tempDirsSince(baseline)).toEqual([]);
	});

	it('fails fast for unknown agents without touching herdr', async () => {
		const result = await singleCall({ agentName: 'ghost' });
		expect(result).toMatchObject({ exitCode: 1, agent: 'ghost', agentSource: 'unknown' });
		expect(result.stderr).toContain('Unknown agent: "ghost"');
		expect(createTaskTab).not.toHaveBeenCalled();
	});

	it('suggests close agent names for typos', async () => {
		const result = await singleCall({ agentName: 'reviewr', agents: [agent, reviewerAgent] });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('Did you mean "reviewer"?');
	});

	it('suggests agents contained in an invented compound name', async () => {
		const result = await singleCall({
			agentName: 'security-reviewer',
			agents: [agent, reviewerAgent],
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('Did you mean "reviewer"?');
		expect(result.stderr).toContain('agents: true');
	});

	it('reports missing workspace resolution', async () => {
		vi.mocked(resolveOwnWorkspace).mockResolvedValue('');
		const result = await singleCall();
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('Could not resolve the herdr workspace');
	});
});

describe('runReusedAgent - relaunch', () => {
	it('recreates the pane and relaunches when the pane is gone', async () => {
		vi.mocked(herdrCli).mockResolvedValue({ error: { code: 'pane_not_found' } });
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'no-agent' });
		registerEntry(makeRegistryEntry({ status: 'running' }));
		const result = await reuseCall();
		expect(result.exitCode).toBe(0);
		expect(createTaskTab).toHaveBeenCalledWith('ws1', '/tmp', 'worker-1');
		expect(result.paneId).toBe('ws1:p9');
		const reg = readRegistry();
		expect(reg.tabs['ws1:worker-1']).toMatchObject({
			paneId: 'ws1:p9',
			tabId: 't9',
			status: 'done',
		});
		expect(launchInPane).toHaveBeenCalledOnce();
	});

	it('reports relaunch failures', async () => {
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'no-agent' });
		vi.mocked(launchInPane).mockResolvedValue('relaunch exploded');
		registerEntry(makeRegistryEntry({ status: 'running' }));
		const result = await reuseCall();
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(
			'Could not relaunch subagent worker-1 in pane ws1:p10 (relaunch exploded)',
		);
		expect(readRegistry().tabs['ws1:worker-1']).toMatchObject({
			status: 'done',
			lastError: expect.stringContaining('Could not relaunch'),
		});
	});
});

describe('runReusedAgent - prompting', () => {
	it('prompts an existing agent', async () => {
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'working' });
		registerEntry(makeRegistryEntry({ status: 'running' }));
		const result = await reuseCall();
		expect(result.exitCode).toBe(0);
		expect(herdrCli).toHaveBeenCalledWith(['agent', 'prompt', 'ws1:p10', 'next task']);
		expect(createTaskTab).not.toHaveBeenCalled();
	});

	it('cleans up the temporary directory when manifest setup fails', async () => {
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'working' });
		vi.mocked(writeReadManifest).mockRejectedValueOnce(new Error('manifest unavailable'));
		registerEntry(makeRegistryEntry({ status: 'running', parentSession: '/sess/parent.jsonl' }));
		const baseline = new Set(tempDirs());
		const result = await runReusedAgent(
			'/tmp',
			[agent],
			'worker-1',
			'next task',
			undefined,
			undefined,
			makeDetails,
			undefined,
			'/sess/parent.jsonl',
			undefined,
			{ scope: { paths: ['src/run.ts'] } },
		);
		expect(result.exitCode).toBe(0);
		const prompt = vi
			.mocked(herdrCli)
			.mock.calls.map((call) => call[0])
			.find((args) => args[0] === 'agent' && args[1] === 'prompt');
		expect(prompt?.[3]).toContain('next task');
		expect(prompt?.[3]).not.toContain('Read the bounded manifest');
		expect(tempDirsSince(baseline)).toEqual([]);
	});

	it('retains manifest metadata and cleans up after a scoped reused prompt', async () => {
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'working' });
		registerEntry(makeRegistryEntry({ status: 'running', parentSession: '/sess/parent.jsonl' }));
		const baseline = new Set(tempDirs());
		const result = await runReusedAgent(
			'/tmp',
			[agent],
			'worker-1',
			'next task',
			undefined,
			undefined,
			makeDetails,
			undefined,
			'/sess/parent.jsonl',
			undefined,
			{ scope: { paths: ['src/run.ts'] } },
		);
		expect(result.exitCode).toBe(0);
		expect(result.readManifest?.persistedPath).toContain('predigest/manifests/');
		expect(fs.existsSync(result.readManifest?.persistedPath as string)).toBe(true);
		expect(tempDirsSince(baseline)).toEqual([]);
		expect(readRegistry().tabs['ws1:worker-1']?.readManifest?.persistedPath).toBe(
			result.readManifest?.persistedPath,
		);
	});

	it('retries prompting and reports persistent failures', async () => {
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'working' });
		vi.mocked(herdrCli).mockResolvedValue({ error: { code: 'prompt_failed' } });
		registerEntry(makeRegistryEntry({ status: 'running' }));
		const result = await reuseCall();
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(
			'Could not prompt subagent worker-1 in pane ws1:p10 (prompt_failed)',
		);
		expect(readRegistry().tabs['ws1:worker-1']).toMatchObject({
			status: 'done',
			lastError: expect.stringContaining('Could not prompt'),
		});
		const promptCalls = vi.mocked(herdrCli).mock.calls.filter((c) => c[0][0] === 'agent');
		expect(promptCalls).toHaveLength(3);
	});
});

describe('runReusedAgent - lookups', () => {
	it('fails fast for unknown labels', async () => {
		const result = await reuseCall('ghost-1');
		expect(result).toMatchObject({ exitCode: 1, agent: 'ghost-1', agentSource: 'reuse' });
		expect(result.stderr).toContain('No subagent session labeled "ghost-1"');
		expect(createTaskTab).not.toHaveBeenCalled();
	});

	it('rejects a same-workspace session owned by another Pi session without side effects', async () => {
		registerEntry(
			makeRegistryEntry({
				status: 'done',
				parentSession: '/sess/other.jsonl',
				reuseCount: 2,
				tasks: ['old task'],
			}),
		);
		const before = readRegistry();
		const result = await reuseCall('worker-1', 'next task', '/sess/current.jsonl');
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('active Pi session');
		expect(herdrCli).not.toHaveBeenCalled();
		expect(createTaskTab).not.toHaveBeenCalled();
		expect(readRegistry()).toEqual(before);
	});

	it('reuses a session owned by the active Pi session', async () => {
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'working' });
		registerEntry(makeRegistryEntry({ status: 'done', parentSession: '/sess/current.jsonl' }));
		const result = await reuseCall('worker-1', 'next task', '/sess/current.jsonl');
		expect(result.exitCode).toBe(0);
		const prompt = vi
			.mocked(herdrCli)
			.mock.calls.map((call) => call[0])
			.find((args) => args[1] === 'prompt');
		expect(prompt?.[3]).toMatch(
			/^ledger: .*ledger\.md@\d+ \(advanced since your session started; read it with the read tool before continuing\)\n\nnext task$/,
		);
	});
});

describe('runReusedAgent - flow ledger', () => {
	it('keeps the raw task out of the ledger pointer line when pointers are off', async () => {
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'working' });
		fs.writeFileSync(
			configPath(),
			JSON.stringify({ ...structuredClone(DEFAULT_CONFIG), ledgerPointers: false }),
		);
		try {
			registerEntry(
				makeRegistryEntry({ status: 'done', parentSession: '/sess/current.jsonl', flowId: 'f1' }),
			);
			const result = await reuseCall('worker-1', 'next task', '/sess/current.jsonl');
			expect(result.exitCode).toBe(0);
			expect(herdrCli).toHaveBeenCalledWith(['agent', 'prompt', 'ws1:p10', 'next task']);
			expect(result.ledgerInjection).toBe('none');
		} finally {
			fs.rmSync(configPath(), { force: true });
		}
	});

	it('writes a dispatch revision and points the launch prompt at it', async () => {
		let promptText = '';
		vi.mocked(launchInPane).mockImplementation(async (_paneId, command) => {
			const match = /--append-system-prompt '?([^'\s]+)'?/.exec(command);
			if (match?.[1]) promptText = fs.readFileSync(match[1], 'utf-8');
			return null;
		});
		const result = await singleCall({
			parentSession: '/sess/parent.jsonl',
			orchestration: { taskId: 'T-001', acceptanceCriteria: ['AC-001'] },
		});
		expect(result.ledgerInjection).toBe('prefix');
		expect(promptText).toContain('You are a worker.');
		expect(promptText).toContain('## Orchestration ledger');
		const ledger = fs.readFileSync(ledgerPath(result.flowId ?? 'missing'), 'utf-8');
		expect(ledger).toContain('kind: dispatch');
		expect(ledger).toContain('task_id: T-001');
		expect(ledger).toContain('attempt: 1');
		expect(ledger).toContain('acceptance_criteria: AC-001');
		expect(parseLedger(ledger).map((revision) => revision.revision)).toEqual([1, 2]);
	});

	it('folds the child ledger and the report path into a result revision', async () => {
		vi.mocked(pollSubagent).mockImplementation(async (...args) => {
			args[4].messages.push(assistantMsg(LEDGER_REPORT));
			return 'settled';
		});
		const result = await singleCall({
			parentSession: '/sess/parent.jsonl',
			orchestration: { taskId: 'T-002' },
		});
		const ledger = fs.readFileSync(ledgerPath(result.flowId ?? 'missing'), 'utf-8');
		expect(ledger).toContain('kind: result');
		expect(ledger).toContain('delegation_status: completed');
		expect(ledger).toContain('validation_verdict: PASS');
		expect(ledger).toContain(`report: ${result.report?.path}`);
		expect(result.ledgerRevision).toBe(2);
		const [record] = readTelemetryRecords();
		expect(record).toMatchObject({
			taskId: 'T-002',
			ledgerRevision: 2,
			ledgerInjection: 'prefix',
		});
	});

	it('counts attempts from the ledger rather than trusting the caller', async () => {
		let flowId = 'missing';
		for (const round of [1, 2]) {
			const result = await singleCall({
				parentSession: '/sess/parent.jsonl',
				orchestration: { taskId: 'T-003', tier: round },
			});
			flowId = result.flowId ?? flowId;
		}
		const ledger = fs.readFileSync(ledgerPath(flowId), 'utf-8');
		expect(ledger).toContain('attempt: 1');
		expect(ledger).toContain('attempt: 2');
	});
});

describe('runReusedAgent - reuse accounting', () => {
	it('records reuse count and appends task history on reuse', async () => {
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'working' });
		registerEntry(makeRegistryEntry({ status: 'done', reuseCount: 2, tasks: ['first', 'second'] }));
		const result = await reuseCall();
		expect(result.exitCode).toBe(0);
		expect(readRegistry().tabs['ws1:worker-1']).toMatchObject({
			reuseCount: 3,
			tasks: ['first', 'second', 'next task'],
		});
	});

	it('starts reuse accounting from zero for a fresh session', async () => {
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'working' });
		registerEntry(makeRegistryEntry({ status: 'done' }));
		const result = await reuseCall();
		expect(result.exitCode).toBe(0);
		expect(readRegistry().tabs['ws1:worker-1']).toMatchObject({
			reuseCount: 1,
			tasks: ['next task'],
		});
	});

	it('records the post-increment reuse count in the telemetry record', async () => {
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'working' });
		registerEntry(makeRegistryEntry({ status: 'done', reuseCount: 2 }));
		await reuseCall();
		const records = readTelemetryRecords();
		const last = records[records.length - 1];
		expect(last).toMatchObject({ label: 'worker-1', reused: true, reuseCount: 3 });
		expect(last?.reuseCount).toBe(readRegistry().tabs['ws1:worker-1']?.reuseCount);
	});
});

describe('delegation identity', () => {
	it('exports the orchestration identity into the child launch command', async () => {
		const result = await singleCall({ parentSession: '/sess/parent.jsonl' });
		expect(result.exitCode).toBe(0);
		const command = vi.mocked(launchInPane).mock.calls[0][1];
		expect(command).toContain("PI_ORCHESTRATION_ROLE='worker'");
		expect(command).toMatch(/PI_DELEGATION_ID='[0-9a-f-]{36}'/);
		expect(command).toMatch(/PI_ORCHESTRATION_FLOW='f[0-9a-f]{16}'/);
		expect(command).toContain("PI_ORCHESTRATION_EVIDENCE_SCOPE='flow'");
		expect(result.delegationId).toMatch(/^[0-9a-f-]{36}$/);
		expect(result.flowId).toMatch(/^f[0-9a-f]{16}$/);
	});

	it('omits the flow id when no parent session is known', async () => {
		const result = await singleCall();
		const command = vi.mocked(launchInPane).mock.calls[0][1];
		expect(command).toContain("PI_SUBAGENT_NESTED='1'");
		expect(command).toContain("PI_ORCHESTRATION_ROLE='worker'");
		expect(command).toMatch(/PI_DELEGATION_ID='[0-9a-f-]{36}'/);
		expect(command).not.toContain('PI_ORCHESTRATION_FLOW');
		expect(result.flowId).toBeUndefined();
	});

	it('honours narrowing of the evidence scope and exports the inherited default', async () => {
		await singleCall({
			agentName: 'validator',
			task: 'check it',
			parentSession: '/sess/parent.jsonl',
			orchestration: { evidenceScope: 'session' },
			agents: [validatorAgent],
		});
		expect(vi.mocked(launchInPane).mock.calls[0][1]).toContain(
			"PI_ORCHESTRATION_EVIDENCE_SCOPE='session'",
		);

		await singleCall({
			agentName: 'validator',
			task: 'check it',
			parentSession: '/sess/parent.jsonl',
			agents: [validatorAgent],
		});
		expect(vi.mocked(launchInPane).mock.calls[1][1]).toContain(
			"PI_ORCHESTRATION_EVIDENCE_SCOPE='flow'",
		);
	});

	it('records delegation context on the registry entry and a spend summary', async () => {
		vi.mocked(pollSubagent).mockImplementation(async (...args) => {
			args[4].messages.push(
				assistantMsg('done', {
					toolCalls: [{ id: 't1', name: 'bash', args: { command: 'ls' } }],
					usage: { totalTokens: 900 },
				}),
			);
			return 'settled';
		});
		const result = await singleCall({
			parentSession: '/sess/parent.jsonl',
			orchestration: {
				tier: 2,
				workflowMode: 'remediation',
				acceptanceCriteria: ['F-001', 'bad id'],
			},
		});
		expect(readRegistry().tabs['ws1:worker-1']).toMatchObject({
			delegationId: result.delegationId,
			flowId: result.flowId,
			tier: 2,
			workflowMode: 'remediation',
			acceptanceCriteria: ['F-001'],
			evidenceScope: 'flow',
		});
		expect(readRegistry().tabs['ws1:worker-1'].lastRun).toMatchObject({
			toolCalls: 1,
			turns: 1,
		});
	});

	it('creates the flow directory and one telemetry record per delegation turn', async () => {
		const result = await singleCall({ parentSession: '/sess/parent.jsonl' });
		expect(fs.existsSync(path.join(flowsRoot(), result.flowId ?? '', 'reports'))).toBe(true);
		const records = readTelemetryRecords();
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			v: 1,
			delegationId: result.delegationId,
			flowId: result.flowId,
			workspace: 'ws1',
			label: 'worker-1',
			agent: 'worker',
			role: 'worker',
			evidenceScope: 'flow',
			reused: false,
			outcome: 'settled',
			exitCode: 0,
			parentSession: '/sess/parent.jsonl',
		});
		expect(records[0].metrics.toolCalls).toBe(0);
		expect(records[0].metrics.turns).toBe(0);
	});

	it('keeps one delegation id across reuse turns and relaunches', async () => {
		const fresh = await singleCall({ parentSession: '/sess/parent.jsonl' });
		vi.mocked(herdrCli).mockResolvedValue({ error: { code: 'pane_not_found' } });
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'no-agent' });
		const reused = await reuseCall('worker-1', 'next task', '/sess/parent.jsonl');
		expect(reused.exitCode).toBe(0);
		expect(reused.delegationId).toBe(fresh.delegationId);
		expect(reused.flowId).toBe(fresh.flowId);
		const relaunch = vi.mocked(launchInPane).mock.calls[1][1];
		expect(relaunch).toContain(`PI_DELEGATION_ID='${fresh.delegationId}'`);
		expect(relaunch).toContain(`PI_ORCHESTRATION_FLOW='${fresh.flowId}'`);
		const records = readTelemetryRecords();
		expect(records.map((r) => r.reused)).toEqual([false, true]);
	});

	it('records a failure outcome when the child never launches', async () => {
		vi.mocked(launchInPane).mockResolvedValue('boom');
		const result = await singleCall({ parentSession: '/sess/parent.jsonl' });
		expect(result.exitCode).toBe(1);
		const records = readTelemetryRecords();
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ outcome: 'failed', exitCode: 1 });
	});
});

const LEDGER_REPORT = [
	'## Completed',
	'',
	'Wired the digest.',
	'',
	'```text',
	'workflow_version: 1',
	'task_id: demo',
	'delegation_status: completed',
	'validation_verdict: PASS',
	'budget: 4/0/1',
	'```',
	'',
	'x'.repeat(6000),
].join('\n');

describe('role report digest', () => {
	it('delivers a bounded digest, persists the full report, and records it', async () => {
		vi.mocked(pollSubagent).mockImplementation(async (...args) => {
			args[4].messages.push(assistantMsg(LEDGER_REPORT));
			return 'settled';
		});
		const result = await singleCall({ parentSession: '/sess/parent.jsonl' });
		const report = result.report;
		expect(report).toMatchObject({ ledgerParsed: true, truncated: true });
		expect(report?.tokens).toBeGreaterThan(report?.digestTokens ?? 0);
		const reportPath = report?.path ?? 'missing';
		const written = fs.readFileSync(reportPath, 'utf-8');
		expect(written).toContain('# Role report: worker-1 (worker)');
		expect(written).toContain('delegation:');
		expect(written).toContain('x'.repeat(200));
		expect(fs.readdirSync(flowReportsDir(result.flowId ?? 'missing'))).toHaveLength(1);
		const [record] = readTelemetryRecords();
		expect(record?.report).toMatchObject({
			tokens: report?.tokens,
			digestTokens: report?.digestTokens,
			ledgerParsed: true,
			path: reportPath,
		});
		expect(readRegistry().tabs['ws1:worker-1']?.lastRun?.reportTokens).toBe(report?.tokens);
	});

	it('flags a report that carries no ledger block', async () => {
		vi.mocked(pollSubagent).mockImplementation(async (...args) => {
			args[4].messages.push(assistantMsg('Validation Verdict: PASS\n\nall green'));
			return 'settled';
		});
		const result = await singleCall({ parentSession: '/sess/parent.jsonl' });
		expect(result.report?.ledgerParsed).toBe(false);
		expect(result.report?.digest).toContain('Validation Verdict: PASS');
		const [record] = readTelemetryRecords();
		expect(record?.report).toMatchObject({ ledgerParsed: false });
	});

	it('attaches no report to a failed delegation', async () => {
		vi.mocked(pollSubagent).mockImplementation(async (...args) => {
			args[4].exitCode = 1;
			args[4].stderr = 'child crashed';
			return 'failed';
		});
		const result = await singleCall({ parentSession: '/sess/parent.jsonl' });
		expect(result.report).toBeUndefined();
		const [record] = readTelemetryRecords();
		expect(record?.report).toBeUndefined();
	});
});
