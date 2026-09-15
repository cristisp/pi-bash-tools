import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import type { AgentConfig } from './agents.ts';
import { getConfig } from './config.ts';
import {
	delegationFromEntry,
	ENV_FLOW,
	ENV_ROOT_SESSION,
	orchestrationEnv,
	resolveDelegation,
	type EvidenceScopePolicy,
} from './delegation.ts';
import { ensureFlow, recordFlowParticipant } from './flow.ts';
import { ensureReviewSurface, type ReviewSurfaceSnapshot } from './scope.ts';
import { manifestGuidance, recordKnownRefs, writeReadManifest } from './manifest.ts';
import {
	appendLedgerRevision,
	ledgerPrefixBlock,
	ledgerTurnLine,
	type LedgerPointer,
} from './ledger.ts';
import {
	buildRunSummary,
	completionPatch,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
} from './format.ts';
import { normalizeS4Outcome, parseLedgerBlock } from './report.ts';
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
import { buildReportDigest, estimateTokens, writeRoleReport } from './report.ts';
import { budgetSummaryFromMetrics, scopedRoleBudget } from './budget.ts';
import { measureExecutionMetrics } from './metrics.ts';
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
	ReadManifest,
	RegistryEntry,
	RoleReport,
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

function scopeGuidance(delegation: DelegationContext): string {
	const scope = delegation.scope;
	const lines = ['## Assigned review scope'];
	if (delegation.reviewSurfacePath)
		lines.push(`Shared review surface snapshot: ${delegation.reviewSurfacePath}`);
	if (delegation.reviewSurfaceRevision !== undefined)
		lines.push(
			`Review surface revision: ${delegation.reviewSurfaceRevision}${delegation.reviewSurfaceRefreshed ? ' (refreshed for this launch)' : ' (unchanged)'}`,
		);
	if (delegation.dirtyPaths?.length)
		lines.push(`Dirty paths at snapshot: ${delegation.dirtyPaths.join(', ')}`);
	if (scope?.paths?.length) {
		lines.push(`In-scope paths: ${scope.paths.join(', ')}`);
		const budget = scopedRoleBudget(delegation.role, scope.paths.length);
		lines.push(
			`Inspection budget for this scope: ${budget.toolCalls} tool calls and ${budget.discoveryCalls} discovery calls, grown from the ${delegation.role} base for ${scope.paths.length} in-scope paths.`,
		);
	}
	if (scope?.hunks?.length) lines.push(`Assigned hunks: ${scope.hunks.join(', ')}`);
	if (scope?.outOfScope?.length) lines.push(`Out of scope: ${scope.outOfScope.join(', ')}`);
	if (!delegation.reviewSurfacePath && !scope) return '';
	lines.push(
		'Report only on the assigned scope. Do not broaden it without an explicit escalation.',
	);
	return lines.join('\n');
}

function applyReviewSurface(
	currentResult: SingleResult,
	delegation: DelegationContext,
	surface?: ReviewSurfaceSnapshot,
): void {
	if (surface) {
		delegation.reviewSurfacePath = surface.path;
		delegation.reviewSurfaceRevision = surface.revision;
		delegation.reviewSurfaceRefreshed = surface.refreshed;
		delegation.reviewSurfaceHead = surface.head;
		delegation.dirtyPaths = surface.dirtyPaths;
	}
	currentResult.reviewSurfacePath = delegation.reviewSurfacePath;
	currentResult.reviewSurfaceRevision = delegation.reviewSurfaceRevision;
	currentResult.reviewSurfaceRefreshed = delegation.reviewSurfaceRefreshed;
	currentResult.reviewSurfaceHead = delegation.reviewSurfaceHead;
	currentResult.dirtyPaths = delegation.dirtyPaths;
}

function scopedTask(
	task: string,
	delegation: DelegationContext,
	readManifest?: ReadManifest,
): string {
	const sections = [
		delegation.scope || delegation.reviewSurfacePath ? scopeGuidance(delegation) : '',
		readManifest?.persistedPath ? manifestGuidance(readManifest.persistedPath) : '',
	].filter(Boolean);
	return sections.length > 0 ? `${sections.join('\n\n')}\n\n${task}` : task;
}

const PRODUCER_ENVIRONMENT_KEYS = [
	'BASH_TOOLS_INVOCATIONS_PATH',
	'BASH_TOOLS_INVOCATION_STREAM',
	'BASH_TOOLS_TELEMETRY_PATH',
] as const;

function buildLaunchCommand(
	agents: AgentConfig,
	model: string | undefined,
	label: string,
	sessionPath: string,
	taskFilePath: string,
	systemPromptPath: string | null,
	delegation?: DelegationContext,
): string {
	const env: Record<string, string> = { PI_SUBAGENT_NESTED: '1', PI_SUBAGENT_LABEL: label };
	for (const key of PRODUCER_ENVIRONMENT_KEYS) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
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

function removeTempFiles(
	dir: string | null,
	filePath: string | null,
	extraPath?: string | null,
): void {
	for (const target of [filePath, extraPath]) {
		if (target)
			try {
				fs.unlinkSync(target);
			} catch {}
	}
	if (dir)
		try {
			fs.rmdirSync(dir);
		} catch {}
}

function budgetAbortMessage(result: SingleResult): string {
	const breaches = result.budget?.breaches.map((breach) => breach.metric).join(', ');
	return `Budget enforcement aborted ${result.agent}${breaches ? ` after exceeding ${breaches}` : ''}.`;
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
	const budgetAborted = currentResult.budget?.outcome === 'aborted';
	if (budgetAborted) {
		currentResult.exitCode = 1;
		if (!currentResult.stderr) currentResult.stderr = budgetAbortMessage(currentResult);
	}
	if (outcome === 'aborted') {
		if (budgetAborted) {
			if (cleanup && tabId) await closeTab(tabId);
			if (label)
				updateRegistryEntry(label, {
					status: 'done',
					updatedAt: Date.now(),
					...completionPatch(currentResult),
				});
		} else if (cleanup) {
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

function recordExecutionMetrics(
	result: SingleResult,
	startedAt: number,
	delegation?: DelegationContext,
): void {
	const metrics = measureExecutionMetrics(result, startedAt);
	result.metrics = metrics;
	const cfg = getConfig();
	const limits = scopedRoleBudget(result.agent, delegation?.scope?.paths?.length ?? 0, cfg);
	const existing = result.budget;
	result.budget = budgetSummaryFromMetrics(
		result.agent,
		limits,
		{
			toolCalls: metrics.toolCalls,
			discoveryCalls: metrics.discoveryCalls ?? 0,
			fullValidationPasses: metrics.fullValidationPasses ?? 0,
			failedToolCalls: metrics.failedToolCalls,
			repeatedReads: metrics.repeatedReads,
			outputTokens: metrics.reportOutputTokens ?? 0,
			toolArgumentTokens: metrics.toolArgumentOutputTokens ?? 0,
			reasoningTokens: metrics.reasoningTokens ?? existing?.usage.reasoningTokens,
			wallTimeMs: Math.max(metrics.durationMs, existing?.usage.wallTimeMs ?? 0),
		},
		existing,
	);
	if (result.budget.outcome === 'aborted') result.exitCode = 1;
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
	compositionBoundaryId?: string;
}

/**
 * Compresses a settled child report into the digest the parent receives and persists the
 * full text under the flow. Never fails a delegation: the digest is skipped on IO errors.
 */
function attachRoleReport(
	currentResult: SingleResult,
	delegation: DelegationContext | undefined,
	label: string,
): void {
	if (!delegation || isFailedResult(currentResult)) return;
	const output = getResultOutput(currentResult);
	if (!output.trim() || output === '(no output)') return;
	const built = buildReportDigest(output, getConfig().reportDigestTokens, {
		requireFilesReviewed: delegation.role === 'reviewer',
	});
	const report: RoleReport = {
		digest: built.digest,
		tokens: estimateTokens(output),
		digestTokens: built.tokens,
		truncated: built.truncated,
		ledgerParsed: built.ledgerParsed,
		...(delegation.role === 'reviewer'
			? {
					filesReviewedPresent: built.filesReviewedPresent,
					filesReviewed: built.filesReviewed,
					contractIssues: built.contractIssues,
				}
			: {}),
	};
	const reportPath = writeRoleReport({
		flowId: delegation.flowId,
		label: label || delegation.role,
		delegation,
		readManifest: currentResult.readManifest,
		output,
	});
	if (reportPath) report.path = reportPath;
	currentResult.report = report;
}

/**
 * Records the dispatch revision and returns the pointer to hand the child. `undefined` means the
 * flow has no ledger, in which case the child is told nothing rather than something untrue.
 */
function recordLedgerDispatch(
	delegation: DelegationContext,
	options: { reused: boolean; label?: string },
): LedgerPointer | undefined {
	if (!getConfig().ledgerPointers) return undefined;
	ensureFlow({ flowId: delegation.flowId });
	return appendLedgerRevision({
		flowId: delegation.flowId,
		kind: 'dispatch',
		delegation,
		reused: options.reused,
		...(options.label ? { label: options.label } : {}),
	});
}

function emitDelegationTelemetry(
	currentResult: SingleResult,
	delegation: DelegationContext | undefined,
	context: DelegationFinishContext,
): void {
	if (!delegation) return;
	const outcome =
		context.aborted || currentResult.budget?.outcome === 'aborted'
			? 'aborted'
			: isFailedResult(currentResult)
				? 'failed'
				: 'settled';
	const childLedger = parseLedgerBlock(getFinalOutput(currentResult.messages));
	const childFields = childLedger?.fields ? { ...childLedger.fields } : undefined;
	const omitted =
		currentResult.metrics?.validationRefs?.flatMap((reference) => reference.omitted ?? []) ?? [];
	if (childFields && omitted.length > 0) {
		childFields.validation_omitted = [...new Set(omitted)].join(',');
		if (/^(pass(?:ed)?|ok|success)$/i.test(childFields.validation_verdict ?? ''))
			childFields.validation_verdict = 'incomplete';
	}
	const revision = appendLedgerRevision({
		flowId: delegation.flowId,
		kind: 'result',
		delegation,
		label: context.label || undefined,
		reused: context.reused,
		outcome,
		exitCode: currentResult.exitCode,
		toolCalls: currentResult.metrics?.toolCalls,
		failedToolCalls: currentResult.metrics?.failedToolCalls,
		turns: currentResult.metrics?.turns,
		reportPath: currentResult.report?.path,
		childFields,
	});
	if (revision) currentResult.ledgerRevision = revision.revision;
	recordKnownRefs({
		flowId: delegation.flowId,
		delegationId: delegation.delegationId,
		refs: currentResult.metrics?.validationRefs ?? [],
	});
	if (!currentResult.ledgerInjection) currentResult.ledgerInjection = 'none';
	const normalized = normalizeS4Outcome(
		childFields,
		delegation.role,
		currentResult.report,
		currentResult.budget,
		outcome,
	);
	const s4LedgerRevision = currentResult.ledgerRevision ?? revision?.revision;
	const s4CorrelationAvailable = Boolean(
		context.compositionBoundaryId &&
		delegation.flowId &&
		delegation.taskId &&
		typeof s4LedgerRevision === 'number' &&
		Number.isSafeInteger(s4LedgerRevision) &&
		s4LedgerRevision > 0,
	);
	const s4Outcome = s4CorrelationAvailable
		? {
				v: 1 as const,
				...normalized,
				correlation: {
					flowId: delegation.flowId!,
					taskId: delegation.taskId!,
					delegationId: delegation.delegationId,
					ledgerRevision: s4LedgerRevision!,
					compositionBoundaryId: context.compositionBoundaryId!,
					...(delegation.tier !== undefined ? { tier: delegation.tier } : {}),
				},
			}
		: undefined;
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
			report: currentResult.report,
			ledger: {
				revision: currentResult.ledgerRevision,
				injection: currentResult.ledgerInjection,
			},
			s4Outcome,
		}),
	);
	if (!context.label) return;
	recordFlowParticipant({ flowId: delegation.flowId, label: context.label, agent: context.agent });
	if (currentResult.metrics) {
		const lastRun = buildRunSummary(
			currentResult.metrics,
			currentResult.usage,
			currentResult.report,
			{
				revision: currentResult.ledgerRevision,
				injection: currentResult.ledgerInjection,
			},
			Date.now(),
			currentResult.budget,
		);
		lastRun.scope = currentResult.scope;
		lastRun.reviewSurfacePath = currentResult.reviewSurfacePath;
		lastRun.reviewSurfaceRevision = delegation.reviewSurfaceRevision;
		lastRun.reviewSurfaceRefreshed = delegation.reviewSurfaceRefreshed;
		lastRun.dirtyPaths = delegation.dirtyPaths;
		lastRun.readManifest = currentResult.readManifest;
		updateRegistryEntry(context.label, {
			lastRun,
			...(currentResult.readManifest ? { readManifest: currentResult.readManifest } : {}),
		});
	}
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
		let manifestPath: string | null = null;
		let readManifest: ReadManifest | undefined;
		if (delegation) {
			try {
				const manifest = await writeReadManifest(taskTmp.dir, delegation);
				manifestPath = manifest.path;
				readManifest = manifest.manifest;
				await fs.promises.writeFile(
					taskTmp.filePath,
					`Task: ${task}\n\n${manifestGuidance(manifest.path)}`,
					'utf8',
				);
			} catch {}
		}
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
			manifestPath,
			readManifest,
		};
		return { kind: 'relaunch', error: launchError ?? '', tmp };
	}
	let promptError = '';
	let manifestTmp: AgentTempFiles | null = null;
	if (delegation?.scope) {
		let tmp: { dir: string; filePath: string } | null = null;
		try {
			tmp = await writePromptToTempFile(entry.agent, 'read manifest follows');
			const manifest = await writeReadManifest(tmp.dir, delegation);
			manifestTmp = {
				promptDir: null,
				promptPath: null,
				taskDir: tmp.dir,
				taskPath: tmp.filePath,
				manifestPath: manifest.path,
				readManifest: manifest.manifest,
			};
		} catch {
			if (tmp) removeTempFiles(tmp.dir, tmp.filePath);
		}
	}
	const promptTask = manifestTmp?.manifestPath
		? `${task}\n\n${manifestGuidance(manifestTmp.manifestPath)}`
		: task;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const resp = await herdrCli(['agent', 'prompt', paneId, promptTask]);
			const code = herdrErrorCode(resp);
			if (!code) return { kind: 'prompt', error: '', tmp: manifestTmp };
			promptError = herdrErrorText(resp) || code;
		} catch (err) {
			promptError = (err as Error).message;
		}
		if (attempt < 2) await sleep(1000);
	}
	return { kind: 'prompt', error: promptError, tmp: manifestTmp };
}

// fallow-ignore-next-line complexity
interface AgentTempFiles {
	promptDir: string | null;
	promptPath: string | null;
	taskDir: string;
	taskPath: string;
	manifestPath: string | null;
	readManifest?: ReadManifest;
}

async function writeAgentTempFiles(
	agent: AgentConfig,
	task: string,
	ledger?: LedgerPointer,
	delegation?: DelegationContext,
): Promise<AgentTempFiles> {
	let promptDir: string | null = null;
	let promptPath: string | null = null;
	const taskTmp = await writePromptToTempFile(agent.name, `Task: ${task}`);
	let manifestPath: string | null = null;
	let readManifest: ReadManifest | undefined;
	if (delegation) {
		try {
			const manifest = await writeReadManifest(taskTmp.dir, delegation);
			manifestPath = manifest.path;
			readManifest = manifest.manifest;
		} catch {}
	}
	const systemPrompt = [
		agent.systemPrompt.trim(),
		ledger ? ledgerPrefixBlock(ledger) : '',
		delegation ? scopeGuidance(delegation) : '',
		manifestPath ? manifestGuidance(manifestPath) : '',
	]
		.filter(Boolean)
		.join('\n\n');
	if (systemPrompt.trim()) {
		const tmp = await writePromptToTempFile(agent.name, systemPrompt);
		promptDir = tmp.dir;
		promptPath = tmp.filePath;
	}
	return {
		promptDir,
		promptPath,
		taskDir: taskTmp.dir,
		taskPath: taskTmp.filePath,
		manifestPath,
		readManifest,
	};
}

async function createFreshSubagentTab(
	agent: AgentConfig,
	defaultCwd: string,
	cwd: string | undefined,
	parentSession: string | undefined,
	currentResult: SingleResult,
	task: string,
	delegation: DelegationContext,
	ledgerRevisionAtLaunch?: number,
): Promise<{ paneId: string; tabId: string; label: string; sessionPath: string } | null> {
	const alloc = allocateLabel(agent.name);
	const label = alloc.label;
	currentResult.label = label;
	currentResult.delegationId = delegation.delegationId;
	if (delegation.flowId) currentResult.flowId = delegation.flowId;
	if (delegation.rootSession) currentResult.rootSession = delegation.rootSession;
	if (delegation.parentPaneId) currentResult.parentPaneId = delegation.parentPaneId;
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
		contextTokens: 0,
		tasks: [task],
		parentSession,
		...(delegation.rootSession ? { rootSession: delegation.rootSession } : {}),
		...(delegation.parentPaneId ? { parentPaneId: delegation.parentPaneId } : {}),
		delegationId: delegation.delegationId,
		...(delegation.flowId ? { flowId: delegation.flowId } : {}),
		...(delegation.reviewSurfaceRevision !== undefined
			? { reviewSurfaceRevision: delegation.reviewSurfaceRevision }
			: {}),
		...(delegation.reviewSurfaceRefreshed !== undefined
			? { reviewSurfaceRefreshed: delegation.reviewSurfaceRefreshed }
			: {}),
		...(delegation.dirtyPaths?.length ? { dirtyPaths: delegation.dirtyPaths } : {}),
		...(typeof delegation.tier === 'number' ? { tier: delegation.tier } : {}),
		...(delegation.workflowMode ? { workflowMode: delegation.workflowMode } : {}),
		...(delegation.reviewMode ? { reviewMode: delegation.reviewMode } : {}),
		...(delegation.acceptanceCriteria?.length
			? { acceptanceCriteria: delegation.acceptanceCriteria }
			: {}),
		...(delegation.taskId ? { taskId: delegation.taskId } : {}),
		evidenceScope: delegation.evidenceScope,
		scope: delegation.scope,
		reviewSurfacePath: delegation.reviewSurfacePath,
		...(currentResult.readManifest ? { readManifest: currentResult.readManifest } : {}),
		...(ledgerRevisionAtLaunch === undefined ? {} : { ledgerRevisionAtLaunch }),
	});
	ensureFlow({ flowId: delegation.flowId, rootSession: delegation.rootSession ?? parentSession });
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
	const surface =
		delegation.reviewSurfacePath && delegation.reviewSurfaceRevision !== undefined
			? undefined
			: ensureReviewSurface(delegation.flowId, cwd ?? defaultCwd);
	applyReviewSurface(currentResult, delegation, surface);
	currentResult.scope = delegation.scope;
	const dispatch = recordLedgerDispatch(delegation, { reused: false });
	if (dispatch) currentResult.ledgerInjection = 'prefix';
	const tmp = await writeAgentTempFiles(
		agent,
		task,
		getConfig().ledgerPointers ? dispatch : undefined,
		delegation,
	);
	currentResult.readManifest = tmp.readManifest;
	const cleanupTmp = (): void => {
		removeTempFiles(tmp.promptDir, tmp.promptPath);
		removeTempFiles(tmp.taskDir, tmp.taskPath, tmp.manifestPath);
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
			dispatch?.revision,
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
			readManifest: entry.readManifest,
			paneId: entry.paneId,
			tabId: entry.tabId,
			delegationId: entry.delegationId,
			flowId: entry.flowId,
			rootSession: entry.rootSession ?? entry.parentSession,
			parentPaneId: entry.parentPaneId,
			tier: entry.tier,
			workflowMode: entry.workflowMode,
			reviewMode: entry.reviewMode,
			taskId: entry.taskId,
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
	s4BoundaryId?: string,
	s4TaskId?: string,
): Promise<SingleResult> {
	const startedAt = Date.now();
	const found = findAgentOrFail(agents, agentName, task, step);
	if (!('systemPrompt' in found)) {
		recordExecutionMetrics(found, startedAt);
		return found;
	}
	const agent = found;
	const childOrchestration = s4TaskId ? { ...orchestration, taskId: s4TaskId } : orchestration;
	const delegation = resolveDelegation({
		role: agentName,
		policy: scopePolicy(),
		parentSession,
		rootSession: process.env[ENV_ROOT_SESSION] ?? parentSession,
		parentPaneId: HERDR_PANE_ID,
		flowId: process.env[ENV_FLOW],
		orchestration: childOrchestration,
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
		...(orchestration?.tier !== undefined ? { tier: orchestration.tier } : {}),
		...(orchestration?.workflowMode ? { workflowMode: orchestration.workflowMode } : {}),
		...(orchestration?.reviewMode ? { reviewMode: orchestration.reviewMode } : {}),
		...(orchestration?.taskId ? { taskId: orchestration.taskId } : {}),
	};
	currentResult.delegationId = delegation.delegationId;
	currentResult.flowId = delegation.flowId;
	currentResult.rootSession = delegation.rootSession;
	currentResult.parentPaneId = delegation.parentPaneId;
	currentResult.scope = delegation.scope;
	applyReviewSurface(currentResult, delegation);
	currentResult.tier = delegation.tier;
	currentResult.workflowMode = delegation.workflowMode;
	currentResult.reviewMode = delegation.reviewMode;
	currentResult.taskId = delegation.taskId;

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
			manifestPath: tab.manifestPath,
			readManifest: tab.readManifest,
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
		recordExecutionMetrics(currentResult, startedAt, delegation);
		attachRoleReport(currentResult, delegation, label);
		emitDelegationTelemetry(currentResult, delegation, {
			label,
			agent: agentName,
			sessionFile,
			parentSession,
			reused: false,
			reuseCount: 0,
			aborted: abortedRun,
			compositionBoundaryId: s4BoundaryId,
		});
		if (tmpFiles) {
			removeTempFiles(tmpFiles.promptDir, tmpFiles.promptPath);
			removeTempFiles(tmpFiles.taskDir, tmpFiles.taskPath, tmpFiles.manifestPath);
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
	s4BoundaryId?: string,
	s4TaskId?: string,
): Promise<SingleResult> {
	const startedAt = Date.now();
	const init = initReusedSession(agents, label, task, parentSession);
	if (!('entry' in init)) {
		recordExecutionMetrics(init, startedAt);
		return init;
	}
	const { entry, agent, currentResult } = init;
	const childOrchestration = s4TaskId ? { ...orchestration, taskId: s4TaskId } : orchestration;
	const delegation = delegationFromEntry(entry, {
		policy: scopePolicy(),
		orchestration: childOrchestration,
		rootSession: entry.rootSession ?? parentSession,
		parentPaneId: HERDR_PANE_ID,
	});
	const surface =
		orchestration?.reviewSurfaceRevision !== undefined
			? undefined
			: ensureReviewSurface(delegation.flowId, entry.cwd || defaultCwd);
	applyReviewSurface(currentResult, delegation, surface);
	currentResult.delegationId = delegation.delegationId;
	currentResult.flowId = delegation.flowId;
	currentResult.rootSession = delegation.rootSession;
	currentResult.parentPaneId = delegation.parentPaneId;
	currentResult.scope = delegation.scope;
	currentResult.tier = delegation.tier;
	currentResult.workflowMode = delegation.workflowMode;
	currentResult.reviewMode = delegation.reviewMode;
	currentResult.taskId = delegation.taskId;
	const model =
		presetModels && Object.hasOwn(presetModels, entry.agent)
			? presetModels[entry.agent]
			: undefined;
	currentResult.model = model;

	let relaunchTmp: AgentTempFiles | null = null;
	let abortedRun = false;

	try {
		const dispatch = recordLedgerDispatch(delegation, { reused: true, label });
		const advanced =
			!entry.ledgerRevisionAtLaunch || (dispatch?.revision ?? 0) > entry.ledgerRevisionAtLaunch;
		if (dispatch && advanced) currentResult.ledgerInjection = 'turn';
		const turnTask = dispatch && advanced ? `${ledgerTurnLine(dispatch)}\n\n${task}` : task;
		const scopedTurnTask = scopedTask(turnTask, delegation, currentResult.readManifest);
		updateRegistryEntry(label, {
			status: 'running',
			updatedAt: Date.now(),
			budget: undefined,
			blockedSince: undefined,
			blockReason: undefined,
			blockedPreview: undefined,
			delegationId: delegation.delegationId,
			...(delegation.rootSession ? { rootSession: delegation.rootSession } : {}),
			...(delegation.parentPaneId ? { parentPaneId: delegation.parentPaneId } : {}),
			...(delegation.flowId ? { flowId: delegation.flowId } : {}),
			...(delegation.reviewSurfaceRevision !== undefined
				? { reviewSurfaceRevision: delegation.reviewSurfaceRevision }
				: {}),
			...(delegation.reviewSurfaceRefreshed !== undefined
				? { reviewSurfaceRefreshed: delegation.reviewSurfaceRefreshed }
				: {}),
			...(delegation.dirtyPaths?.length ? { dirtyPaths: delegation.dirtyPaths } : {}),
			...(typeof delegation.tier === 'number' ? { tier: delegation.tier } : {}),
			...(delegation.workflowMode ? { workflowMode: delegation.workflowMode } : {}),
			...(delegation.reviewMode ? { reviewMode: delegation.reviewMode } : {}),
			...(delegation.acceptanceCriteria?.length
				? { acceptanceCriteria: delegation.acceptanceCriteria }
				: {}),
			...(delegation.taskId ? { taskId: delegation.taskId } : {}),
			evidenceScope: delegation.evidenceScope,
			scope: delegation.scope,
			reviewSurfacePath: delegation.reviewSurfacePath,
			...(delegation.reviewSurfaceRevision !== undefined
				? { reviewSurfaceRevision: delegation.reviewSurfaceRevision }
				: {}),
			...(delegation.reviewSurfaceRefreshed !== undefined
				? { reviewSurfaceRefreshed: delegation.reviewSurfaceRefreshed }
				: {}),
			...(delegation.dirtyPaths?.length ? { dirtyPaths: delegation.dirtyPaths } : {}),
			...(dispatch ? { ledgerRevisionAtLaunch: dispatch.revision } : {}),
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

		const relaunch = await relaunchOrPrompt(
			agent,
			model,
			entry,
			label,
			scopedTurnTask,
			paneId,
			delegation,
		);
		if (!relaunch) throw new Error('relaunchOrPrompt returned no outcome');
		relaunchTmp = relaunch.tmp;
		if (relaunch.tmp?.readManifest) currentResult.readManifest = relaunch.tmp.readManifest;
		if (currentResult.readManifest)
			updateRegistryEntry(label, {
				readManifest: currentResult.readManifest,
				updatedAt: Date.now(),
			});
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
		recordExecutionMetrics(currentResult, startedAt, delegation);
		if (!abortedRun && currentResult.exitCode !== 0 && label)
			updateRegistryEntry(label, completionPatch(currentResult));
		attachRoleReport(currentResult, delegation, label);
		emitDelegationTelemetry(currentResult, delegation, {
			label,
			agent: entry.agent,
			sessionFile: entry.sessionFile,
			parentSession,
			reused: true,
			reuseCount: findEntry(label)?.reuseCount ?? entry.reuseCount ?? 0,
			aborted: abortedRun,
			compositionBoundaryId: s4BoundaryId,
		});
		if (relaunchTmp) {
			removeTempFiles(relaunchTmp.promptDir, relaunchTmp.promptPath);
			removeTempFiles(relaunchTmp.taskDir, relaunchTmp.taskPath, relaunchTmp.manifestPath);
		}
	}
}
