import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import type { AgentConfig } from './agents.ts';
import { completionPatch } from './format.ts';
import {
	closeTab,
	createTaskTab,
	getAgentStatus,
	herdrCli,
	herdrErrorCode,
	herdrErrorText,
	HERDR_PANE_ID,
	launchInPane,
	ownWorkspaceId,
	resolveOwnWorkspace,
	sleep,
} from './herdr.ts';
import { pollSubagent } from './poll.ts';
import {
	allocateLabel,
	registerEntry,
	removeRegistryEntry,
	updateRegistryEntry,
} from './registry.ts';
import { readRegistry, sanitizeSegment } from './registry-store.ts';
import { ABORT_ERROR, makeEmptyUsage } from './types.ts';
import type {
	BlockEventInfo,
	OnUpdateCallback,
	RegistryEntry,
	SingleResult,
	SubagentDetails,
} from './types.ts';

async function writePromptToTempFile(
	agentName: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pi-subagent-'));
	const safeName = sanitizeSegment(agentName);
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: 'utf-8', mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function shellQuote(s: string): string {
	return `'${s.replaceAll("'", "'\\''")}'`;
}

function buildLaunchCommand(
	agent: AgentConfig,
	label: string,
	sessionPath: string,
	taskFilePath: string,
	systemPromptPath: string | null,
): string {
	const parts: string[] = ['PI_SUBAGENT_NESTED=1', 'pi'];
	parts.push('--name', shellQuote(label));
	parts.push('--session', shellQuote(sessionPath));
	if (agent.model) parts.push('--model', shellQuote(agent.model));
	if (agent.tools && agent.tools.length > 0)
		parts.push('--tools', shellQuote(agent.tools.join(',')));
	if (systemPromptPath) parts.push('--append-system-prompt', shellQuote(systemPromptPath));
	parts.push(`"$(cat ${shellQuote(taskFilePath)})"`);
	return parts.join(' ');
}

function removeTempFiles(dir: string | null, filePath: string | null): void {
	if (filePath)
		try {
			fs.unlinkSync(filePath);
		} catch {}
	if (dir)
		try {
			fs.rmdirSync(dir);
		} catch {}
}

// fallow-ignore-next-line complexity
async function applyOutcome(
	outcome: 'settled' | 'failed' | 'gone' | 'aborted',
	currentResult: SingleResult,
	paneId: string,
	tabId: string | null,
	label: string,
	cleanup: boolean,
): Promise<'done' | 'aborted'> {
	if (outcome === 'aborted') {
		if (cleanup) {
			if (tabId) await closeTab(tabId);
			if (label) removeRegistryEntry(label);
		}
		return 'aborted';
	}
	if (outcome === 'gone') {
		currentResult.exitCode = 1;
		currentResult.stderr = `Subagent pane ${paneId} was closed before the task completed.`;
		if (cleanup) removeRegistryEntry(label);
		return 'done';
	}
	if (outcome === 'failed') {
		currentResult.exitCode = 1;
		if (cleanup) {
			if (tabId) await closeTab(tabId);
			removeRegistryEntry(label);
		}
		return 'done';
	}
	updateRegistryEntry(label, completionPatch(currentResult));
	return 'done';
}

function failedResult(
	agent: string,
	agentSource: SingleResult['agentSource'],
	task: string,
	stderr: string,
	step?: number,
): SingleResult {
	return {
		agent,
		agentSource,
		task,
		exitCode: 1,
		messages: [],
		stderr,
		usage: makeEmptyUsage(),
		step,
	};
}

async function ensurePaneExists(
	entry: { paneId: string; tabId: string; cwd?: string },
	defaultCwd: string,
	label: string,
	currentResult: SingleResult,
): Promise<{ paneId: string; tabId: string } | null> {
	const paneResp = await herdrCli(['pane', 'get', entry.paneId]);
	if (herdrErrorCode(paneResp) !== 'pane_not_found')
		return { paneId: entry.paneId, tabId: entry.tabId };
	const workspaceId = await resolveOwnWorkspace();
	if (!workspaceId) {
		currentResult.exitCode = 1;
		currentResult.stderr = `Could not resolve the herdr workspace for pane ${HERDR_PANE_ID ?? '(none)'}.`;
		return null;
	}
	const created = await createTaskTab(workspaceId, entry.cwd || defaultCwd, label);
	return { paneId: created.paneId, tabId: created.tabId };
}

async function relaunchOrPrompt(
	agent: AgentConfig | undefined,
	entry: { agent: string; sessionFile: string },
	label: string,
	task: string,
	paneId: string,
): Promise<{ kind: 'relaunch' | 'prompt'; error: string } | null> {
	const { status } = await getAgentStatus(paneId);
	if (status === 'no-agent') {
		if (!agent) return { kind: 'relaunch', error: 'no agent' };
		const taskTmp = await writePromptToTempFile(entry.agent, `Task: ${task}`);
		const command = buildLaunchCommand(agent, label, entry.sessionFile, taskTmp.filePath, null);
		const launchError = await launchInPane(paneId, command);
		removeTempFiles(taskTmp.dir, taskTmp.filePath);
		return launchError ? { kind: 'relaunch', error: launchError } : null;
	}
	let promptError = '';
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const resp = await herdrCli(['agent', 'prompt', paneId, task]);
			const code = herdrErrorCode(resp);
			if (!code) return null;
			promptError = herdrErrorText(resp) || code;
		} catch (err) {
			promptError = (err as Error).message;
		}
		if (attempt < 2) await sleep(1000);
	}
	return { kind: 'prompt', error: promptError };
}

// fallow-ignore-next-line complexity
async function writeAgentTempFiles(
	agent: AgentConfig,
	task: string,
): Promise<{
	promptDir: string | null;
	promptPath: string | null;
	taskDir: string;
	taskPath: string;
}> {
	let promptDir: string | null = null;
	let promptPath: string | null = null;
	if (agent.systemPrompt.trim()) {
		const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
		promptDir = tmp.dir;
		promptPath = tmp.filePath;
	}
	const taskTmp = await writePromptToTempFile(agent.name, `Task: ${task}`);
	return { promptDir, promptPath, taskDir: taskTmp.dir, taskPath: taskTmp.filePath };
}

async function createFreshSubagentTab(
	agent: AgentConfig,
	defaultCwd: string,
	cwd: string | undefined,
	parentSession: string | undefined,
	currentResult: SingleResult,
): Promise<{ paneId: string; tabId: string; label: string; sessionPath: string } | null> {
	const alloc = allocateLabel(agent.name);
	const label = alloc.label;
	currentResult.label = label;
	const sessionPath = alloc.sessionFile;

	const workspaceId = await resolveOwnWorkspace();
	if (!workspaceId) {
		currentResult.exitCode = 1;
		currentResult.stderr = `Could not resolve the herdr workspace for pane ${HERDR_PANE_ID ?? '(none)'}.`;
		return null;
	}

	const created = await createTaskTab(workspaceId, cwd ?? defaultCwd, label);
	currentResult.paneId = created.paneId;
	currentResult.tabId = created.tabId;
	registerEntry({
		label,
		agent: agent.name,
		workspace: ownWorkspaceId(),
		paneId: created.paneId,
		tabId: created.tabId,
		sessionFile: sessionPath,
		cwd: cwd ?? defaultCwd,
		status: 'running',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		lastResult: '',
		contextTokens: 0,
		parentSession,
	});
	return { paneId: created.paneId, tabId: created.tabId, label, sessionPath };
}

async function launchSubagent(
	agent: AgentConfig,
	label: string,
	sessionPath: string,
	taskPath: string,
	promptPath: string | null,
	paneId: string,
	currentResult: SingleResult,
): Promise<boolean> {
	const command = buildLaunchCommand(agent, label, sessionPath, taskPath, promptPath);
	const launchError = await launchInPane(paneId, command);
	if (launchError) {
		currentResult.exitCode = 1;
		currentResult.stderr = `Could not launch subagent in pane ${paneId} (${launchError}).`;
		return false;
	}
	return true;
}

async function launchFreshAgent(
	agent: AgentConfig,
	defaultCwd: string,
	cwd: string | undefined,
	task: string,
	parentSession: string | undefined,
	currentResult: SingleResult,
): Promise<{ paneId: string; tabId: string; label: string; sessionPath: string } | null> {
	const tmp = await writeAgentTempFiles(agent, task);
	try {
		const tab = await createFreshSubagentTab(agent, defaultCwd, cwd, parentSession, currentResult);
		if (!tab) return null;
		const launched = await launchSubagent(
			agent,
			tab.label,
			tab.sessionPath,
			tmp.taskPath,
			tmp.promptPath,
			tab.paneId,
			currentResult,
		);
		if (!launched) {
			await closeTab(tab.tabId);
			removeRegistryEntry(tab.label);
			return null;
		}
		return tab;
	} finally {
		removeTempFiles(tmp.promptDir, tmp.promptPath);
		removeTempFiles(tmp.taskDir, tmp.taskPath);
	}
}

interface ReusedSessionInit {
	entry: RegistryEntry;
	agent: AgentConfig | undefined;
	currentResult: SingleResult;
}

function initReusedSession(
	agents: AgentConfig[],
	label: string,
	task: string,
): ReusedSessionInit | SingleResult {
	const reg = readRegistry();
	const entry = reg.tabs[`${ownWorkspaceId()}:${label}`];

	if (!entry) {
		return failedResult(
			label,
			'reuse',
			task,
			`No subagent session labeled "${label}". Use listSubagents to see available sessions.`,
		);
	}
	const agent = agents.find((a) => a.name === entry.agent);
	return {
		entry,
		agent,
		currentResult: {
			agent: entry.agent,
			agentSource: 'reuse',
			task,
			exitCode: 0,
			messages: [],
			stderr: '',
			usage: makeEmptyUsage(),
			model: agent?.model,
			label,
			paneId: entry.paneId,
			tabId: entry.tabId,
		},
	};
}

function sessionFileOffset(sessionFile: string): number {
	try {
		return fs.statSync(sessionFile).size;
	} catch {
		return 0;
	}
}

function findAgentOrFail(
	agents: AgentConfig[],
	agentName: string,
	task: string,
	step: number | undefined,
): AgentConfig | SingleResult {
	const agent = agents.find((a) => a.name === agentName);
	if (agent) return agent;
	const available = agents.map((a) => `"${a.name}"`).join(', ') || 'none';
	return failedResult(
		agentName,
		'unknown',
		task,
		`Unknown agent: "${agentName}". Available agents: ${available}.`,
		step,
	);
}

async function pollAndApply(
	paneId: string,
	sessionPath: string,
	signal: AbortSignal | undefined,
	currentResult: SingleResult,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	onBlocked: ((info: BlockEventInfo) => void) | undefined,
	tabId: string,
	label: string,
): Promise<void> {
	const outcome = await pollSubagent(
		paneId,
		sessionPath,
		0,
		signal,
		currentResult,
		onUpdate,
		makeDetails,
		onBlocked,
	);
	const applied = await applyOutcome(outcome, currentResult, paneId, tabId, label, true);
	if (applied === 'aborted') throw ABORT_ERROR;
}

// fallow-ignore-next-line complexity
export async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	parentSession: string | undefined,
	onBlocked?: (info: BlockEventInfo) => void,
): Promise<SingleResult> {
	const found = findAgentOrFail(agents, agentName, task, step);
	if (!('systemPrompt' in found)) return found;
	const agent = found;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: '',
		usage: makeEmptyUsage(),
		model: agent.model,
		step,
	};

	let tabId: string | null = null;
	let label = '';

	try {
		const tab = await launchFreshAgent(agent, defaultCwd, cwd, task, parentSession, currentResult);
		if (!tab) return currentResult;
		tabId = tab.tabId;
		label = tab.label;

		await pollAndApply(
			tab.paneId,
			tab.sessionPath,
			signal,
			currentResult,
			onUpdate,
			makeDetails,
			onBlocked,
			tabId,
			label,
		);
		return currentResult;
	} catch (err) {
		if (err === ABORT_ERROR) throw err;
		currentResult.exitCode = 1;
		currentResult.stderr = (err as Error).message || String(err);
		if (tabId) await closeTab(tabId);
		if (label) removeRegistryEntry(label);
		return currentResult;
	}
}

export async function runReusedAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	label: string,
	task: string,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	onBlocked?: (info: BlockEventInfo) => void,
): Promise<SingleResult> {
	const init = initReusedSession(agents, label, task);
	if (!('entry' in init)) return init;
	const { entry, agent, currentResult } = init;

	try {
		updateRegistryEntry(label, { status: 'running', updatedAt: Date.now() });

		let paneId = entry.paneId;
		let tabId = entry.tabId;
		const ensured = await ensurePaneExists(entry, defaultCwd, label, currentResult);
		if (!ensured) return currentResult;
		paneId = ensured.paneId;
		tabId = ensured.tabId;
		if (paneId !== entry.paneId) {
			currentResult.paneId = paneId;
			currentResult.tabId = tabId;
			updateRegistryEntry(label, { paneId, tabId, updatedAt: Date.now() });
		}

		const relaunchError = await relaunchOrPrompt(agent, entry, label, task, paneId);
		if (relaunchError) {
			currentResult.exitCode = 1;
			currentResult.stderr = `Could not ${relaunchError.kind} subagent ${label} in pane ${paneId} (${relaunchError.error}).`;
			return currentResult;
		}

		const outcome = await pollSubagent(
			paneId,
			entry.sessionFile,
			sessionFileOffset(entry.sessionFile),
			signal,
			currentResult,
			onUpdate,
			makeDetails,
			onBlocked,
		);

		const applied = await applyOutcome(outcome, currentResult, paneId, tabId, label, false);
		if (applied === 'aborted') throw ABORT_ERROR;
		return currentResult;
	} catch (err) {
		if (err === ABORT_ERROR) throw err;
		currentResult.exitCode = 1;
		currentResult.stderr = (err as Error).message || String(err);
		return currentResult;
	}
}
