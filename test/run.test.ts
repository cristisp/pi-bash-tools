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
import { pollSubagent } from '../src/poll.ts';
import { runReusedAgent, runSingleAgent } from '../src/run.ts';
import { registerEntry } from '../src/registry.ts';
import { readRegistry } from '../src/registry-store.ts';
import { readTelemetryRecords, telemetryPath } from '../src/telemetry.ts';
import { flowsRoot } from '../src/flow.ts';
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

function countTempDirs(): number {
	try {
		return fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('pi-subagent-')).length;
	} catch {
		return 0;
	}
}

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
		const before = countTempDirs();
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
		expect(countTempDirs()).toBe(before);
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
		const before = countTempDirs();
		let resolvePoll!: (value: 'aborted' | 'gone' | 'settled' | 'failed') => void;
		vi.mocked(pollSubagent).mockReturnValue(
			new Promise<'aborted' | 'gone' | 'settled' | 'failed'>((resolve) => {
				resolvePoll = resolve;
			}),
		);
		const promise = singleCall({ step: 1 });
		await vi.waitFor(() => {
			expect(countTempDirs()).toBeGreaterThan(before);
		});
		resolvePoll('settled');
		const result = await promise;
		expect(result.exitCode).toBe(0);
		expect(countTempDirs()).toBe(before);
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
	it('cleans up and unregisters on launch failure', async () => {
		vi.mocked(launchInPane).mockResolvedValue('boom');
		const before = countTempDirs();
		const result = await singleCall();
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('Could not launch subagent in pane ws1:p9 (boom)');
		expect(closeTab).toHaveBeenCalledWith('t9');
		expect(readRegistry().tabs).toEqual({});
		expect(countTempDirs()).toBe(before);
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

	it('retries prompting and reports persistent failures', async () => {
		vi.mocked(getAgentStatus).mockResolvedValue({ status: 'working' });
		vi.mocked(herdrCli).mockResolvedValue({ error: { code: 'prompt_failed' } });
		registerEntry(makeRegistryEntry({ status: 'running' }));
		const result = await reuseCall();
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(
			'Could not prompt subagent worker-1 in pane ws1:p10 (prompt_failed)',
		);
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
		expect(herdrCli).toHaveBeenCalledWith(['agent', 'prompt', 'ws1:p10', 'next task']);
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

	it('honours narrowing and refuses widening of the evidence scope', async () => {
		await singleCall({
			parentSession: '/sess/parent.jsonl',
			orchestration: { evidenceScope: 'session' },
		});
		expect(vi.mocked(launchInPane).mock.calls[0][1]).toContain(
			"PI_ORCHESTRATION_EVIDENCE_SCOPE='session'",
		);

		await singleCall({
			agentName: 'validator',
			task: 'check it',
			parentSession: '/sess/parent.jsonl',
			orchestration: { evidenceScope: 'flow' },
			agents: [validatorAgent],
		});
		expect(vi.mocked(launchInPane).mock.calls[1][1]).toContain(
			"PI_ORCHESTRATION_EVIDENCE_SCOPE='session'",
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
