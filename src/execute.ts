import * as path from 'node:path';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { StringEnum } from '@earendil-works/pi-ai';
import { getAgentDir, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { discoverAgents } from './agents.ts';
import type { AgentConfig, AgentScope } from './agents.ts';
import { getConfig } from './config.ts';
import {
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	truncateParallelOutput,
} from './format.ts';
import { NESTED, ownWorkspaceId } from './herdr.ts';
import { listSubagents } from './registry.ts';
import { runReusedAgent, runSingleAgent } from './run.ts';
import { makeEmptyUsage } from './types.ts';
import type { BlockEventInfo, OnUpdateCallback, SingleResult, SubagentDetails } from './types.ts';

const TaskItem = Type.Object({
	agent: Type.String({ description: 'Name of the agent to invoke' }),
	task: Type.String({ description: 'Task to delegate to the agent' }),
	cwd: Type.Optional(Type.String({ description: 'Working directory for the agent process' })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: 'Name of the agent to invoke' }),
	task: Type.String({ description: 'Task with optional {previous} placeholder for prior output' }),
	cwd: Type.Optional(Type.String({ description: 'Working directory for the agent process' })),
});

const AgentScopeSchema = StringEnum(['user', 'project', 'both'] as const, {
	description:
		'Which agent directories to use. Default: "user" (or config defaultAgentScope). Use "both" to include project-local agents.',
	default: 'user',
});

const REUSE_WORKFLOW_DESCRIPTION =
	'For safe reuse, first call subagent with listSubagents: true, select an exact active-session entry, copy its bare reuseLabel, call subagent_stats with that label, and reuse only when the stats and task history show it is appropriate. Never infer or increment labels, use labels from another workspace, or pass workspace:label to reuseLabel or subagent_stats.';

export const SubagentParams = Type.Object({
	agent: Type.Optional(
		Type.String({ description: 'Name of the agent to invoke (for single mode)' }),
	),
	task: Type.Optional(
		Type.String({
			description:
				'Task to delegate (for single mode, or the message to send when reusing a session)',
		}),
	),
	tasks: Type.Optional(
		Type.Array(TaskItem, { description: 'Array of {agent, task} for parallel execution' }),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, { description: 'Array of {agent, task} for sequential execution' }),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description:
				'Prompt before running project-local agents. Default: true (or config confirmProjectAgents).',
			default: true,
		}),
	),
	cwd: Type.Optional(
		Type.String({ description: 'Working directory for the agent process (single mode)' }),
	),
	listSubagents: Type.Optional(
		Type.Boolean({
			description: `${REUSE_WORKFLOW_DESCRIPTION} Each entry shows the exact bare label to pass as reuseLabel.`,
		}),
	),
	listLabel: Type.Optional(
		Type.String({
			description:
				'With listSubagents: only show the session with this label linked to the active Pi session (bare or active-workspace-qualified for filtering, e.g. worker-1 or ws1:worker-1)',
		}),
	),
	listStatus: Type.Optional(
		Type.String({
			description: 'With listSubagents: only show sessions with this status (running or done)',
		}),
	),
	listVerbose: Type.Optional(
		Type.Boolean({
			description: 'With listSubagents: show the full last result instead of an 80-char preview',
		}),
	),
	agents: Type.Optional(
		Type.Boolean({
			description:
				'List available agents (name, description, source) for the current agentScope; call this before picking an agent name',
		}),
	),
	reuseLabel: Type.Optional(
		Type.String({
			description: `${REUSE_WORKFLOW_DESCRIPTION} Continue the selected session in place (preserving its context); send task as the next message.`,
		}),
	),
});

export type SubagentParams = Static<typeof SubagentParams>;

type SubagentMode = 'single' | 'parallel' | 'chain' | 'reuse' | 'list' | 'agents';

function resolveMode(params: SubagentParams): SubagentMode | null {
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	const hasList = params.listSubagents === true;
	const hasReuse = Boolean(params.reuseLabel);
	const hasAgents = params.agents === true;
	const modeCount =
		Number(hasChain) +
		Number(hasTasks) +
		Number(hasSingle) +
		Number(hasList) +
		Number(hasReuse) +
		Number(hasAgents);
	if (modeCount !== 1) return null;
	if (hasChain) return 'chain';
	if (hasTasks) return 'parallel';
	if (hasSingle) return 'single';
	if (hasList) return 'list';
	if (hasAgents) return 'agents';
	return 'reuse';
}

interface ExecuteContext {
	agentScope: AgentScope;
	sessionFile: string | undefined;
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	cwd: string;
	signal: AbortSignal | undefined;
	onUpdate: OnUpdateCallback | undefined;
	onBlocked: ((info: BlockEventInfo) => void) | undefined;
}

function makeDetailsFor(ctx: ExecuteContext) {
	return (mode: 'single' | 'parallel' | 'chain') =>
		(results: SingleResult[]): SubagentDetails => ({
			mode,
			agentScope: ctx.agentScope,
			projectAgentsDir: ctx.projectAgentsDir,
			results,
		});
}

function buildExecuteContext(
	params: SubagentParams,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	ctx: ExtensionContext,
): { executeCtx: ExecuteContext; makeDetails: ReturnType<typeof makeDetailsFor> } {
	const agentScope: AgentScope = params.agentScope ?? getConfig().defaultAgentScope;
	const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
	const discovery = discoverAgents(ctx.cwd, agentScope);
	const executeCtx: ExecuteContext = {
		agentScope,
		sessionFile,
		agents: discovery.agents,
		projectAgentsDir: discovery.projectAgentsDir,
		cwd: ctx.cwd,
		signal,
		onUpdate,
		onBlocked: buildOnBlocked(ctx),
	};
	return { executeCtx, makeDetails: makeDetailsFor(executeCtx) };
}

function invalidParamsResponse(
	agents: AgentConfig[],
	makeDetails: ReturnType<typeof makeDetailsFor>,
	text: string,
): AgentToolResult<SubagentDetails> {
	const available = agents.map((a) => `${a.name} (${a.source})`).join(', ') || 'none';
	return {
		content: [{ type: 'text', text: text.replace('{available}', available) }],
		details: makeDetails('single')([]),
	};
}

function appendReuseLabel(text: string, label: string | undefined): string {
	return label ? `${text}\n\nreuseLabel: ${label}` : text;
}

function appendChainReuseLabels(text: string, results: SingleResult[]): string {
	const labels = results
		.filter((result): result is SingleResult & { label: string } => Boolean(result.label))
		.map((result, index) => `- step ${result.step ?? index + 1}: reuseLabel: ${result.label}`);
	return labels.length > 0 ? `${text}\n\nReusable session labels:\n${labels.join('\n')}` : text;
}

async function executeChainMode(
	ctx: ExecuteContext,
	chain: Static<typeof ChainItem>[],
): Promise<AgentToolResult<SubagentDetails>> {
	const makeDetails = makeDetailsFor(ctx);
	const results: SingleResult[] = [];
	let previousOutput = '';

	for (let i = 0; i < chain.length; i++) {
		const step = chain[i];
		const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

		const chainUpdate: OnUpdateCallback | undefined = ctx.onUpdate
			? (partial) => {
					const currentResult = partial.details?.results[0];
					if (currentResult) {
						const allResults = [...results, currentResult];
						ctx.onUpdate?.({
							content: partial.content,
							details: makeDetails('chain')(allResults),
						});
					}
				}
			: undefined;

		const result = await runSingleAgent(
			ctx.cwd,
			ctx.agents,
			step.agent,
			taskWithContext,
			step.cwd,
			i + 1,
			ctx.signal,
			chainUpdate,
			makeDetails('chain'),
			ctx.sessionFile,
			ctx.onBlocked,
		);
		results.push(result);

		const isError = isFailedResult(result);
		if (isError) {
			const errorMsg = getResultOutput(result);
			return {
				content: [
					{
						type: 'text',
						text: appendChainReuseLabels(
							`Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`,
							results,
						),
					},
				],
				details: makeDetails('chain')(results),
			};
		}
		previousOutput = getFinalOutput(result.messages);
	}
	return {
		content: [
			{
				type: 'text',
				text: appendChainReuseLabels(
					getFinalOutput(results[results.length - 1].messages) || '(no output)',
					results,
				),
			},
		],
		details: makeDetails('chain')(results),
	};
}

function initParallelResults(tasks: Static<typeof TaskItem>[]): SingleResult[] {
	const results = Array.from<SingleResult>({ length: tasks.length });
	for (let i = 0; i < tasks.length; i++) {
		results[i] = {
			agent: tasks[i].agent,
			agentSource: 'unknown',
			task: tasks[i].task,
			exitCode: -1,
			messages: [],
			stderr: '',
			usage: makeEmptyUsage(),
		};
	}
	return results;
}

function makeParallelUpdateEmit(
	ctx: ExecuteContext,
	allResults: SingleResult[],
	makeDetails: ReturnType<typeof makeDetailsFor>,
): () => void {
	return () => {
		if (ctx.onUpdate) {
			const running = allResults.filter((r) => r.exitCode === -1).length;
			const done = allResults.filter((r) => r.exitCode !== -1).length;
			ctx.onUpdate({
				content: [
					{
						type: 'text',
						text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
					},
				],
				details: makeDetails('parallel')([...allResults]),
			});
		}
	};
}

async function runParallelTask(
	ctx: ExecuteContext,
	task: Static<typeof TaskItem>,
	index: number,
	allResults: SingleResult[],
	emitUpdate: () => void,
	makeDetails: ReturnType<typeof makeDetailsFor>,
): Promise<SingleResult> {
	const result = await runSingleAgent(
		ctx.cwd,
		ctx.agents,
		task.agent,
		task.task,
		task.cwd,
		undefined,
		ctx.signal,
		(partial) => {
			if (partial.details?.results[0]) {
				allResults[index] = partial.details.results[0];
				emitUpdate();
			}
		},
		makeDetails('parallel'),
		ctx.sessionFile,
		ctx.onBlocked,
	);
	allResults[index] = result;
	emitUpdate();
	return result;
}

function parallelSummaryText(results: SingleResult[]): string {
	const successCount = results.filter((r) => !isFailedResult(r)).length;
	const summaries = results.map((r) => {
		const output = truncateParallelOutput(getResultOutput(r));
		const status = isFailedResult(r)
			? `failed${r.stopReason && r.stopReason !== 'end' ? ` (${r.stopReason})` : ''}`
			: 'completed';
		const label = r.label ? `\n\nreuseLabel: ${r.label}` : '';
		return `### [${r.label ?? r.agent}] ${status}${label}\n\n${output}`;
	});
	return `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join('\n\n---\n\n')}`;
}

async function executeParallelMode(
	ctx: ExecuteContext,
	tasks: Static<typeof TaskItem>[],
): Promise<AgentToolResult<SubagentDetails>> {
	const makeDetails = makeDetailsFor(ctx);
	const maxParallelTasks = getConfig().maxParallelTasks;
	if (tasks.length > maxParallelTasks) {
		return {
			content: [
				{
					type: 'text',
					text: `Too many parallel tasks (${tasks.length}). Max is ${maxParallelTasks}.`,
				},
			],
			details: makeDetails('parallel')([]),
		};
	}

	const allResults = initParallelResults(tasks);
	const emitUpdate = makeParallelUpdateEmit(ctx, allResults, makeDetails);
	const results = await mapWithConcurrencyLimit(tasks, getConfig().maxConcurrency, (task, index) =>
		runParallelTask(ctx, task, index, allResults, emitUpdate, makeDetails),
	);
	return {
		content: [{ type: 'text', text: parallelSummaryText(results) }],
		details: makeDetails('parallel')(results),
	};
}

async function executeSingleMode(
	ctx: ExecuteContext,
	agent: string,
	task: string,
	cwd: string | undefined,
): Promise<AgentToolResult<SubagentDetails>> {
	const makeDetails = makeDetailsFor(ctx);
	const result = await runSingleAgent(
		ctx.cwd,
		ctx.agents,
		agent,
		task,
		cwd,
		undefined,
		ctx.signal,
		ctx.onUpdate,
		makeDetails('single'),
		ctx.sessionFile,
		ctx.onBlocked,
	);
	const isError = isFailedResult(result);
	if (isError) {
		const errorMsg = getResultOutput(result);
		return {
			content: [
				{
					type: 'text',
					text: appendReuseLabel(
						`Agent ${result.stopReason || 'failed'}: ${errorMsg}`,
						result.label,
					),
				},
			],
			details: makeDetails('single')([result]),
		};
	}
	return {
		content: [
			{
				type: 'text',
				text: appendReuseLabel(getFinalOutput(result.messages) || '(no output)', result.label),
			},
		],
		details: makeDetails('single')([result]),
	};
}

async function executeReuseMode(
	ctx: ExecuteContext,
	reuseLabel: string,
	task: string,
): Promise<AgentToolResult<SubagentDetails>> {
	const makeDetails = makeDetailsFor(ctx);
	const result = await runReusedAgent(
		ctx.cwd,
		ctx.agents,
		reuseLabel,
		task,
		ctx.signal,
		ctx.onUpdate,
		makeDetails('single'),
		ctx.onBlocked,
		ctx.sessionFile,
	);
	const isError = isFailedResult(result);
	if (isError) {
		return {
			content: [
				{
					type: 'text',
					text: appendReuseLabel(
						`Reuse ${result.stopReason || 'failed'}: ${getResultOutput(result)}`,
						result.label ?? reuseLabel,
					),
				},
			],
			details: makeDetails('single')([result]),
		};
	}
	return {
		content: [
			{
				type: 'text',
				text: appendReuseLabel(
					getFinalOutput(result.messages) || '(no output)',
					result.label ?? reuseLabel,
				),
			},
		],
		details: makeDetails('single')([result]),
	};
}

function buildOnBlocked(ctx: ExtensionContext): ((info: BlockEventInfo) => void) | undefined {
	if (!ctx.hasUI) return undefined;
	return (info) => {
		if (info.resolved) {
			const suffix =
				info.blockReason === 'steer' ? ' - still needs input in its tab' : ' - continuing';
			ctx.ui.notify(
				`Subagent ${ownWorkspaceId()}:${info.label} is no longer awaiting approval${suffix}`,
				'info',
			);
			return;
		}
		ctx.ui.notify(
			`Subagent ${ownWorkspaceId()}:${info.label} is awaiting approval${info.preview ? `: ${info.preview}` : ''} (approve/reject in its tab)`,
			'warning',
		);
	};
}

async function confirmProjectAgentsIfNeeded(
	ctx: ExtensionContext,
	params: SubagentParams,
	agents: AgentConfig[],
	projectAgentsDir: string | null,
	hasChain: boolean,
	hasTasks: boolean,
	makeDetails: ReturnType<typeof makeDetailsFor>,
): Promise<AgentToolResult<SubagentDetails> | null> {
	const requestedAgentNames = new Set<string>();
	if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
	if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
	if (params.agent) requestedAgentNames.add(params.agent);

	const projectAgentsRequested = Array.from(requestedAgentNames)
		.map((name) => agents.find((a) => a.name === name))
		.filter((a): a is AgentConfig => a?.source === 'project');

	if (projectAgentsRequested.length === 0) return null;
	const names = projectAgentsRequested.map((a) => a.name).join(', ');
	const dir = projectAgentsDir ?? '(unknown)';
	const ok = await ctx.ui.confirm(
		'Run project-local agents?',
		`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
	);
	if (ok) return null;
	return {
		content: [{ type: 'text', text: 'Canceled: project-local agents not approved.' }],
		details: makeDetails(hasChain ? 'chain' : hasTasks ? 'parallel' : 'single')([]),
	};
}

function nestedResponse(
	mode: SubagentMode,
	makeDetails: ReturnType<typeof makeDetailsFor>,
): AgentToolResult<SubagentDetails> {
	return {
		content: [
			{
				type: 'text',
				text: 'Nested subagents are disabled: this session is itself a subagent (PI_SUBAGENT_NESTED is set), so it cannot spawn its own subagents.',
			},
		],
		details: makeDetails(mode as 'single')([]),
	};
}

function listResponse(
	params: SubagentParams,
	makeDetails: ReturnType<typeof makeDetailsFor>,
	parentSession: string | undefined,
): AgentToolResult<SubagentDetails> {
	return {
		content: [
			{
				type: 'text',
				text: listSubagents({
					label: params.listLabel,
					status: params.listStatus,
					verbose: params.listVerbose,
					parentSession,
				}),
			},
		],
		details: makeDetails('single')([]),
	};
}

function agentsResponse(
	ctx: ExecuteContext,
	makeDetails: ReturnType<typeof makeDetailsFor>,
): AgentToolResult<SubagentDetails> {
	if (ctx.agents.length === 0) {
		return {
			content: [
				{
					type: 'text',
					text: `No agents found for agentScope "${ctx.agentScope}" (looked in ${path.join(getAgentDir(), 'agents')}${ctx.projectAgentsDir ? ` and ${ctx.projectAgentsDir}` : ''}). Use agentScope "user" or "both" for user agents, or create agent files.`,
				},
			],
			details: makeDetails('single')([]),
		};
	}
	const lines = ctx.agents.map((a) => {
		const model = a.model ? `, model: ${a.model}` : '';
		return `- ${a.name} (${a.source}) - ${a.description}${model}`;
	});
	return {
		content: [
			{
				type: 'text',
				text: `Available agents (agentScope: ${ctx.agentScope}):\n${lines.join('\n')}\n\nPick the agent whose description best fits the task and use its exact name; do not invent agent names.`,
			},
		],
		details: makeDetails('single')([]),
	};
}

function reuseWithoutTaskResponse(
	makeDetails: ReturnType<typeof makeDetailsFor>,
): AgentToolResult<SubagentDetails> {
	return {
		content: [
			{
				type: 'text',
				text: 'Invalid parameters. reuseLabel requires a task (the next message for that session).',
			},
		],
		details: makeDetails('single')([]),
	};
}

function sessionOwnerUnavailableResponse(
	makeDetails: ReturnType<typeof makeDetailsFor>,
): AgentToolResult<SubagentDetails> {
	return {
		content: [
			{
				type: 'text',
				text: 'Subagent session ownership is unavailable: the current Pi session has no session file, so listing and reuse are unavailable.',
			},
		],
		details: makeDetails('single')([]),
	};
}

// fallow-ignore-next-line complexity
export async function executeSubagent(
	params: SubagentParams,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<SubagentDetails>> {
	const { executeCtx, makeDetails } = buildExecuteContext(params, signal, onUpdate, ctx);
	const mode = resolveMode(params);
	if (!mode) {
		return invalidParamsResponse(
			executeCtx.agents,
			makeDetails,
			'Invalid parameters. Provide exactly one mode (single, parallel, chain, reuse, list, or agents).\nAvailable agents: {available}',
		);
	}
	if ((mode === 'list' || mode === 'reuse') && !executeCtx.sessionFile) {
		return sessionOwnerUnavailableResponse(makeDetails);
	}
	if (NESTED) return nestedResponse(mode, makeDetails);
	if (mode === 'list') {
		return listResponse(params, makeDetails, executeCtx.sessionFile);
	}
	if (mode === 'agents') {
		return agentsResponse(executeCtx, makeDetails);
	}
	if (mode === 'reuse') {
		if (!params.task) return reuseWithoutTaskResponse(makeDetails);
		return executeReuseMode(executeCtx, params.reuseLabel!, params.task);
	}
	const confirmProjectAgents = params.confirmProjectAgents ?? getConfig().confirmProjectAgents;
	if (
		(executeCtx.agentScope === 'project' || executeCtx.agentScope === 'both') &&
		confirmProjectAgents &&
		ctx.hasUI
	) {
		const denied = await confirmProjectAgentsIfNeeded(
			ctx,
			params,
			executeCtx.agents,
			executeCtx.projectAgentsDir,
			mode === 'chain',
			mode === 'parallel',
			makeDetails,
		);
		if (denied) return denied;
	}
	if (mode === 'chain') return executeChainMode(executeCtx, params.chain!);
	if (mode === 'parallel') return executeParallelMode(executeCtx, params.tasks!);
	return executeSingleMode(executeCtx, params.agent!, params.task!, params.cwd);
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results = Array.from<TOut>({ length: items.length });
	let nextIndex = 0;
	const workers = Array.from({ length: limit }, async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}
