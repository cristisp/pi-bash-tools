import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import type { AgentConfig } from './agents.ts';
import { getConfig } from './config.ts';
import {
	delegationFromEntry,
	orchestrationEnv,
	resolveDelegation,
	type EvidenceScopePolicy,
} from './delegation.ts';
import { ensureFlow, recordFlowParticipant } from './flow.ts';
import { buildRunSummary, completionPatch, getFinalOutput, isFailedResult } from './format.ts';
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
	resolveWorkspaceName,
	sleep,
} from './herdr.ts';
import { pollSubagent } from './poll.ts';
import {
	allocateLabel,
	findEntry,
	registerEntry,
	removeRegistryEntry,
	updateRegistryEntry,
} from './registry.ts';
import { sanitizeSegment } from './registry-store.ts';
import { appendTelemetryRecord, buildTelemetryRecord } from './telemetry.ts';
import { ABORT_ERROR, makeEmptyUsage } from './types.ts';
import type {
	BlockEventInfo,
	DelegationContext,
	OnUpdateCallback,
	OrchestrationContext,
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
	agents: AgentConfig,
	model: string | undefined,
	label: string,
	sessionPath: string,
	taskFilePath: string,
	systemPromptPath: string | null,
	delegation?: DelegationContext,
): string {
	const env: Record<string, string> = { PI_SUBAGENT_NESTED: '1' };
	if (delegation) Object.assign(env, orchestrationEnv(delegation));
	const parts: string[] = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`);
	parts.push('pi');
	parts.push('--name', shellQuote(label));
	parts.push('--session', shellQuote(sessionPath));
	if (model) parts.push('--model', shellQuote(model));
	if (agents.tools && agents.tools.length > 0)
		parts.push('--tools', shellQuote(agents.tools.join(',')));
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

function recordExecutionMetrics(result: SingleResult, startedAt: number): void {
	let toolCalls = 0;
	let failedToolCalls = 0;
	let repeatedReads = 0;
	let maxContextTokens = 0;
	let turns = 0;
	const readCounts = new Map<string, number>();
	for (const message of result.messages) {
		if (message.role === 'assistant') {
			turns++;
			for (const part of message.content) {
				if (part.type !== 'toolCall') continue;
				toolCalls++;
				if (part.name === 'read') {
					const args = part.arguments;
					const filePath = typeof args.file_path === 'string' ? args.file_path : args.path;
					if (typeof filePath === 'string') {
						const key = `${filePath}:${String(args.offset ?? '')}:${String(args.limit ?? '')}`;
						const count = readCounts.get(key) ?? 0;
						if (count > 0) repeatedReads++;
						readCounts.set(key, count + 1);
					}
				}
			}
			maxContextTokens = Math.max(maxContextTokens, message.usage.totalTokens || 0);
		} else if (message.role === 'toolResult' && message.isError) {
			failedToolCalls++;
		}
	}
	result.metrics = {
		durationMs: Math.max(0, Date.now() - startedAt),
		toolCalls,
		failedToolCalls,
		repeatedReads,
		messageCount: result.messages.length,
		taskChars: result.task.length,
		outputChars: getFinalOutput(result.messages).length,
		maxContextTokens,
		turns,
		blockEvents: result.blockDurations?.count ?? 0,
		approvalMs: result.blockDurations?.approvalMs ?? 0,
		steerMs: result.blockDurations?.steerMs ?? 0,
	};
}

function scopePolicy(cfg = getConfig()): EvidenceScopePolicy {
	return {
		evidenceScopeDefault: cfg.evidenceScopeDefault,
		evidenceScopeByRole: cfg.evidenceScopeByRole,
	};
}

interface DelegationFinishContext {
	label: string;
	agent: string;
	sessionFile?: string;
	parentSession?: string;
	reused: boolean;
	reuseCount: number;
	aborted: boolean;
}

function emitDelegationTelemetry(
	currentResult: SingleResult,
	delegation: DelegationContext | undefined,
	context: DelegationFinishContext,
): void {
	if (!delegation) return;
	const outcome = context.aborted
		? 'aborted'
		: isFailedResult(currentResult)
			? 'failed'
			: 'settled';
	appendTelemetryRecord(
		buildTelemetryRecord({
			delegation,
			workspace: ownWorkspaceId(),
			label: context.label || delegation.role,
			agent: context.agent,
			reused: context.reused,
			reuseCount: context.reuseCount,
			outcome,
			parentSession: context.parentSession,
			sessionFile: context.sessionFile,
			result: currentResult,
		}),
	);
	if (!context.label) return;
	recordFlowParticipant({ flowId: delegation.flowId, label: context.label, agent: context.agent });
	if (currentResult.metrics)
		updateRegistryEntry(context.label, {
			lastRun: buildRunSummary(currentResult.metrics, currentResult.usage),
		});
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
	model: string | undefined,
	entry: { agent: string; sessionFile: string },
	label: string,
	task: string,
	paneId: string,
	delegation?: DelegationContext,
): Promise<{
	kind: 'relaunch' | 'prompt';
	error: string;
	tmp: AgentTempFiles | null;
} | null> {
	const { status } = await getAgentStatus(paneId);
	if (status === 'no-agent') {
		if (!agent) return { kind: 'relaunch', error: 'no agent', tmp: null };
		const taskTmp = await writePromptToTempFile(entry.agent, `Task: ${task}`);
		const command = buildLaunchCommand(
			agent,
			model,
			label,
			entry.sessionFile,
			taskTmp.filePath,
			null,
			delegation,
		);
		const launchError = await launchInPane(paneId, command);
		const tmp: AgentTempFiles = {
			promptDir: null,
			promptPath: null,
			taskDir: taskTmp.dir,
			taskPath: taskTmp.filePath,
		};
		return { kind: 'relaunch', error: launchError ?? '', tmp };
	}
	let promptError = '';
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const resp = await herdrCli(['agent', 'prompt', paneId, task]);
			const code = herdrErrorCode(resp);
			if (!code) return { kind: 'prompt', error: '', tmp: null };
			promptError = herdrErrorText(resp) || code;
		} catch (err) {
			promptError = (err as Error).message;
		}
		if (attempt < 2) await sleep(1000);
	}
	return { kind: 'prompt', error: promptError, tmp: null };
}

// fallow-ignore-next-line complexity
interface AgentTempFiles {
	promptDir: string | null;
	promptPath: string | null;
	taskDir: string;
	taskPath: string;
}

async function writeAgentTempFiles(agent: AgentConfig, task: string): Promise<AgentTempFiles> {
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
	task: string,
	delegation: DelegationContext,
): Promise<{ paneId: string; tabId: string; label: string; sessionPath: string } | null> {
	const alloc = allocateLabel(agent.name);
	const label = alloc.label;
	currentResult.label = label;
	currentResult.delegationId = delegation.delegationId;
	if (delegation.flowId) currentResult.flowId = delegation.flowId;
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
	let workspaceName: string | undefined;
	try {
		workspaceName = await resolveWorkspaceName(workspaceId);
	} catch {}
	registerEntry({
		label,
		agent: agent.name,
		workspace: ownWorkspaceId(),
		...(workspaceName ? { workspaceName } : {}),
		paneId: created.paneId,
		tabId: created.tabId,
		sessionFile: sessionPath,
		cwd: cwd ?? defaultCwd,
		status: 'running',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		lastResult: '',
		contextTokens: 0,
		tasks: [task],
		parentSession,
		delegationId: delegation.delegationId,
		...(delegation.flowId ? { flowId: delegation.flowId } : {}),
		...(typeof delegation.tier === 'number' ? { tier: delegation.tier } : {}),
		...(delegation.workflowMode ? { workflowMode: delegation.workflowMode } : {}),
		...(delegation.reviewMode ? { reviewMode: delegation.reviewMode } : {}),
		...(delegation.acceptanceCriteria?.length
			? { acceptanceCriteria: delegation.acceptanceCriteria }
			: {}),
		evidenceScope: delegation.evidenceScope,
	});
	ensureFlow({ flowId: delegation.flowId, rootSession: parentSession });
	recordFlowParticipant({ flowId: delegation.flowId, label, agent: agent.name });
	return { paneId: created.paneId, tabId: created.tabId, label, sessionPath };
}

async function launchSubagent(
	agent: AgentConfig,
	model: string | undefined,
	label: string,
	sessionPath: string,
	taskPath: string,
	promptPath: string | null,
	paneId: string,
	currentResult: SingleResult,
	delegation: DelegationContext,
): Promise<boolean> {
	const command = buildLaunchCommand(
		agent,
		model,
		label,
		sessionPath,
		taskPath,
		promptPath,
		delegation,
	);
	const launchError = await launchInPane(paneId, command);
	if (launchError) {
		currentResult.exitCode = 1;
		currentResult.stderr = `Could not launch subagent in pane ${paneId} (${launchError}).`;
		return false;
	}
	return true;
}

interface FreshAgentTab extends AgentTempFiles {
	paneId: string;
	tabId: string;
	label: string;
	sessionPath: string;
}

async function launchFreshAgent(
	agent: AgentConfig,
	model: string | undefined,
	defaultCwd: string,
	cwd: string | undefined,
	task: string,
	parentSession: string | undefined,
	currentResult: SingleResult,
	delegation: DelegationContext,
): Promise<FreshAgentTab | null> {
	const tmp = await writeAgentTempFiles(agent, task);
	const cleanupTmp = (): void => {
		removeTempFiles(tmp.promptDir, tmp.promptPath);
		removeTempFiles(tmp.taskDir, tmp.taskPath);
	};
	try {
		const tab = await createFreshSubagentTab(
			agent,
			defaultCwd,
			cwd,
			parentSession,
			currentResult,
			task,
			delegation,
		);
		if (!tab) {
			cleanupTmp();
			return null;
		}
		const launched = await launchSubagent(
			agent,
			model,
			tab.label,
			tab.sessionPath,
			tmp.taskPath,
			tmp.promptPath,
			tab.paneId,
			currentResult,
			delegation,
		);
		if (!launched) {
			await closeTab(tab.tabId);
			removeRegistryEntry(tab.label);
			cleanupTmp();
			return null;
		}
		return { ...tab, ...tmp };
	} catch (err) {
		cleanupTmp();
		throw err;
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
	parentSession?: string,
): ReusedSessionInit | SingleResult {
	const entry = findEntry(label, parentSession);

	if (!entry) {
		return failedResult(
			label,
			'reuse',
			task,
			`No subagent session labeled "${label}" in the active Pi session. Use listSubagents and pass the bare label shown after "reuseLabel:"`,
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

function editDistance(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	let prev = Array.from({ length: n + 1 }, (_, j) => j);
	for (let i = 1; i <= m; i++) {
		const curr = [i, ...Array.from({ length: n }, () => 0)];
		for (let j = 1; j <= n; j++) {
			curr[j] = Math.min(
				prev[j] + 1,
				curr[j - 1] + 1,
				prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		prev = curr;
	}
	return prev[n];
}

function suggestAgents(requested: string, agents: AgentConfig[]): string[] {
	const suggestions = new Set<string>();
	for (const a of agents) {
		const d = editDistance(requested, a.name);
		const threshold = Math.max(2, Math.floor(requested.length / 3));
		if (d > 0 && d <= threshold) suggestions.add(a.name);
		else if (a.name.length >= 3 && (requested.includes(a.name) || a.name.includes(requested))) {
			suggestions.add(a.name);
		}
	}
	return Array.from(suggestions).slice(0, 2);
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
	const suggested = suggestAgents(agentName, agents);
	const hint =
		suggested.length > 0 ? ` Did you mean ${suggested.map((s) => `"${s}"`).join(' or ')}?` : '';
	return failedResult(
		agentName,
		'unknown',
		task,
		`Unknown agent: "${agentName}". Available agents: ${available}.${hint} To see agent descriptions, call subagent with agents: true.`,
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
	presetModels?: Record<string, string>,
	orchestration?: OrchestrationContext,
): Promise<SingleResult> {
	const startedAt = Date.now();
	const found = findAgentOrFail(agents, agentName, task, step);
	if (!('systemPrompt' in found)) {
		recordExecutionMetrics(found, startedAt);
		return found;
	}
	const agent = found;
	const delegation = resolveDelegation({
		role: agentName,
		policy: scopePolicy(),
		parentSession,
		orchestration,
	});
	const model =
		presetModels && Object.hasOwn(presetModels, agentName) ? presetModels[agentName] : undefined;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: '',
		usage: makeEmptyUsage(),
		model,
		step,
	};

	let tabId: string | null = null;
	let label = '';
	let tmpFiles: AgentTempFiles | null = null;
	let sessionFile: string | undefined;
	let abortedRun = false;

	try {
		const tab = await launchFreshAgent(
			agent,
			model,
			defaultCwd,
			cwd,
			task,
			parentSession,
			currentResult,
			delegation,
		);
		if (!tab) return currentResult;
		tabId = tab.tabId;
		label = tab.label;
		sessionFile = tab.sessionPath;
		tmpFiles = {
			promptDir: tab.promptDir,
			promptPath: tab.promptPath,
			taskDir: tab.taskDir,
			taskPath: tab.taskPath,
		};

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
		if (err === ABORT_ERROR) {
			abortedRun = true;
			throw err;
		}
		currentResult.exitCode = 1;
		currentResult.stderr = (err as Error).message || String(err);
		if (tabId) await closeTab(tabId);
		if (label) removeRegistryEntry(label);
		return currentResult;
	} finally {
		recordExecutionMetrics(currentResult, startedAt);
		emitDelegationTelemetry(currentResult, delegation, {
			label,
			agent: agentName,
			sessionFile,
			parentSession,
			reused: false,
			reuseCount: 0,
			aborted: abortedRun,
		});
		if (tmpFiles) {
			removeTempFiles(tmpFiles.promptDir, tmpFiles.promptPath);
			removeTempFiles(tmpFiles.taskDir, tmpFiles.taskPath);
		}
	}
}

const MAX_TASK_HISTORY = 5;

function recordTask(label: string, entry: RegistryEntry, task: string): void {
	updateRegistryEntry(label, {
		reuseCount: (entry.reuseCount ?? 0) + 1,
		tasks: [...(entry.tasks ?? []), task].slice(-MAX_TASK_HISTORY),
	});
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
	parentSession?: string,
	presetModels?: Record<string, string>,
	orchestration?: OrchestrationContext,
): Promise<SingleResult> {
	const startedAt = Date.now();
	const init = initReusedSession(agents, label, task, parentSession);
	if (!('entry' in init)) {
		recordExecutionMetrics(init, startedAt);
		return init;
	}
	const { entry, agent, currentResult } = init;
	const delegation = delegationFromEntry(entry, { policy: scopePolicy(), orchestration });
	currentResult.delegationId = delegation.delegationId;
	if (delegation.flowId) currentResult.flowId = delegation.flowId;
	const model =
		presetModels && Object.hasOwn(presetModels, entry.agent)
			? presetModels[entry.agent]
			: undefined;
	currentResult.model = model;

	let relaunchTmp: AgentTempFiles | null = null;
	let abortedRun = false;

	try {
		updateRegistryEntry(label, {
			status: 'running',
			updatedAt: Date.now(),
			delegationId: delegation.delegationId,
			...(delegation.flowId ? { flowId: delegation.flowId } : {}),
			...(typeof delegation.tier === 'number' ? { tier: delegation.tier } : {}),
			...(delegation.workflowMode ? { workflowMode: delegation.workflowMode } : {}),
			...(delegation.reviewMode ? { reviewMode: delegation.reviewMode } : {}),
			...(delegation.acceptanceCriteria?.length
				? { acceptanceCriteria: delegation.acceptanceCriteria }
				: {}),
			evidenceScope: delegation.evidenceScope,
		});
		recordTask(label, entry, task);

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

		const relaunch = await relaunchOrPrompt(agent, model, entry, label, task, paneId, delegation);
		if (!relaunch) throw new Error('relaunchOrPrompt returned no outcome');
		relaunchTmp = relaunch.tmp;
		if (relaunch.error) {
			currentResult.exitCode = 1;
			currentResult.stderr = `Could not ${relaunch.kind} subagent ${label} in pane ${paneId} (${relaunch.error}).`;
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
		if (err === ABORT_ERROR) {
			abortedRun = true;
			throw err;
		}
		currentResult.exitCode = 1;
		currentResult.stderr = (err as Error).message || String(err);
		return currentResult;
	} finally {
		recordExecutionMetrics(currentResult, startedAt);
		emitDelegationTelemetry(currentResult, delegation, {
			label,
			agent: entry.agent,
			sessionFile: entry.sessionFile,
			parentSession,
			reused: true,
			reuseCount: findEntry(label)?.reuseCount ?? entry.reuseCount ?? 0,
			aborted: abortedRun,
		});
		if (relaunchTmp) {
			removeTempFiles(relaunchTmp.promptDir, relaunchTmp.promptPath);
			removeTempFiles(relaunchTmp.taskDir, relaunchTmp.taskPath);
		}
	}
}
