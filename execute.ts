import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { discoverAgents } from "./agents.ts";
import type { AgentConfig, AgentScope } from "./agents.ts";
import { getFinalOutput, getResultOutput, isFailedResult, truncateParallelOutput } from "./format.ts";
import { NESTED, ownWorkspaceId } from "./herdr.ts";
import { listSubagents } from "./registry.ts";
import { runReusedAgent, runSingleAgent } from "./run.ts";
import { makeEmptyUsage } from "./types.ts";
import type { BlockReason, OnUpdateCallback, SingleResult, SubagentDetails } from "./types.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

export const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode, or the message to send when reusing a session)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	listSubagents: Type.Optional(Type.Boolean({ description: "List existing subagent sessions (labels, status, panes, session files)" })),
	listLabel: Type.Optional(Type.String({ description: "With listSubagents: only show the session with this label (bare or workspace-qualified, e.g. worker-1 or w8:worker-1)" })),
	listStatus: Type.Optional(Type.String({ description: "With listSubagents: only show sessions with this status (running or done)" })),
	listVerbose: Type.Optional(Type.Boolean({ description: "With listSubagents: show the full last result instead of an 80-char preview" })),
	reuseLabel: Type.Optional(Type.String({ description: "Continue an existing subagent session in place (preserving its context); send `task` as the next message" })),
});

export type SubagentParams = Static<typeof SubagentParams>;

interface ExecuteContext {
	agentScope: AgentScope;
	sessionFile: string | undefined;
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	cwd: string;
	signal: AbortSignal | undefined;
	onUpdate: OnUpdateCallback | undefined;
	onBlocked: ((info: { label: string; blockReason: BlockReason; preview?: string }) => void) | undefined;
}

function makeDetailsFor(ctx: ExecuteContext) {
	return (mode: "single" | "parallel" | "chain") => (results: SingleResult[]): SubagentDetails => ({
		mode,
		agentScope: ctx.agentScope,
		projectAgentsDir: ctx.projectAgentsDir,
		results,
	});
}

function invalidParamsResponse(
	agents: AgentConfig[],
	makeDetails: ReturnType<typeof makeDetailsFor>,
	text: string,
): AgentToolResult<SubagentDetails> {
	const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
	return {
		content: [{ type: "text", text: text.replace("{available}", available) }],
		details: makeDetails("single")([]),
	};
}

async function executeChainMode(
	ctx: ExecuteContext,
	chain: Static<typeof ChainItem>[],
): Promise<AgentToolResult<SubagentDetails>> {
	const makeDetails = makeDetailsFor(ctx);
	const results: SingleResult[] = [];
	let previousOutput = "";

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
							details: makeDetails("chain")(allResults),
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
			makeDetails("chain"),
			ctx.sessionFile,
			ctx.onBlocked,
		);
		results.push(result);

		const isError = isFailedResult(result);
		if (isError) {
			const errorMsg = getResultOutput(result);
			return {
				content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
				details: makeDetails("chain")(results),
			};
		}
		previousOutput = getFinalOutput(result.messages);
	}
	return {
		content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
		details: makeDetails("chain")(results),
	};
}

async function executeParallelMode(
	ctx: ExecuteContext,
	tasks: Static<typeof TaskItem>[],
): Promise<AgentToolResult<SubagentDetails>> {
	const makeDetails = makeDetailsFor(ctx);
	if (tasks.length > MAX_PARALLEL_TASKS) {
		return {
			content: [
				{
					type: "text",
					text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
				},
			],
			details: makeDetails("parallel")([]),
		};
	}

	const allResults: SingleResult[] = new Array(tasks.length);

	for (let i = 0; i < tasks.length; i++) {
		allResults[i] = {
			agent: tasks[i].agent,
			agentSource: "unknown",
			task: tasks[i].task,
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: makeEmptyUsage(),
		};
	}

	const emitParallelUpdate = () => {
		if (ctx.onUpdate) {
			const running = allResults.filter((r) => r.exitCode === -1).length;
			const done = allResults.filter((r) => r.exitCode !== -1).length;
			ctx.onUpdate({
				content: [
					{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
				],
				details: makeDetails("parallel")([...allResults]),
			});
		}
	};

	const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
		const result = await runSingleAgent(
			ctx.cwd,
			ctx.agents,
			t.agent,
			t.task,
			t.cwd,
			undefined,
			ctx.signal,
			(partial) => {
				if (partial.details?.results[0]) {
					allResults[index] = partial.details.results[0];
					emitParallelUpdate();
				}
			},
			makeDetails("parallel"),
			ctx.sessionFile,
			ctx.onBlocked,
		);
		allResults[index] = result;
		emitParallelUpdate();
		return result;
	});

	const successCount = results.filter((r) => !isFailedResult(r)).length;
	const summaries = results.map((r) => {
		const output = truncateParallelOutput(getResultOutput(r));
		const status = isFailedResult(r)
			? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
			: "completed";
		return `### [${r.label ?? r.agent}] ${status}\n\n${output}`;
	});
	return {
		content: [
			{
				type: "text",
				text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
			},
		],
		details: makeDetails("parallel")(results),
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
		makeDetails("single"),
		ctx.sessionFile,
		ctx.onBlocked,
	);
	const isError = isFailedResult(result);
	if (isError) {
		const errorMsg = getResultOutput(result);
		return {
			content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
			details: makeDetails("single")([result]),
		};
	}
	return {
		content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
		details: makeDetails("single")([result]),
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
		makeDetails("single"),
		ctx.onBlocked,
	);
	const isError = isFailedResult(result);
	if (isError) {
		return {
			content: [{ type: "text", text: `Reuse ${result.stopReason || "failed"}: ${getResultOutput(result)}` }],
			details: makeDetails("single")([result]),
		};
	}
	return {
		content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
		details: makeDetails("single")([result]),
	};
}

function buildOnBlocked(
	ctx: ExtensionContext,
): ((info: { label: string; blockReason: BlockReason; preview?: string }) => void) | undefined {
	if (!ctx.hasUI) return undefined;
	return (info) => {
		ctx.ui.notify(
			`Subagent ${ownWorkspaceId()}:${info.label} is awaiting approval${info.preview ? `: ${info.preview}` : ""} (approve/reject in its tab)`,
			"warning",
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
		.filter((a): a is AgentConfig => a?.source === "project");

	if (projectAgentsRequested.length === 0) return null;
	const names = projectAgentsRequested.map((a) => a.name).join(", ");
	const dir = projectAgentsDir ?? "(unknown)";
	const ok = await ctx.ui.confirm(
		"Run project-local agents?",
		`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
	);
	if (ok) return null;
	return {
		content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
		details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
	};
}

// fallow-ignore-next-line complexity
export async function executeSubagent(
	params: SubagentParams,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<SubagentDetails>> {
	const agentScope: AgentScope = params.agentScope ?? "user";
	const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
	const discovery = discoverAgents(ctx.cwd, agentScope);
	const agents = discovery.agents;
	const confirmProjectAgents = params.confirmProjectAgents ?? true;

	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	const hasList = params.listSubagents === true;
	const hasReuse = typeof params.reuseLabel === "string";
	const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle) + Number(hasList) + Number(hasReuse);

	const executeCtx: ExecuteContext = {
		agentScope,
		sessionFile,
		agents,
		projectAgentsDir: discovery.projectAgentsDir,
		cwd: ctx.cwd,
		signal,
		onUpdate,
		onBlocked: buildOnBlocked(ctx),
	};
	const makeDetails = makeDetailsFor(executeCtx);

	if (modeCount !== 1) {
		return invalidParamsResponse(
			agents,
			makeDetails,
			"Invalid parameters. Provide exactly one mode (single, parallel, chain, reuse, or list).\nAvailable agents: {available}",
		);
	}

	if (NESTED) {
		const mode = hasChain ? "chain" : hasTasks ? "parallel" : hasReuse ? "reuse" : hasList ? "list" : "single";
		return {
			content: [
				{
					type: "text",
					text: "Nested subagents are disabled: this session is itself a subagent (PI_SUBAGENT_NESTED is set), so it cannot spawn its own subagents.",
				},
			],
			details: makeDetails(mode as "single")([]),
		};
	}

	if (hasList) {
		return {
			content: [{ type: "text", text: listSubagents({ label: params.listLabel, status: params.listStatus, verbose: params.listVerbose }) }],
			details: makeDetails("single")([]),
		};
	}

	if (hasReuse) {
		if (!params.task) {
			return {
				content: [{ type: "text", text: "Invalid parameters. reuseLabel requires a task (the next message for that session)." }],
				details: makeDetails("single")([]),
			};
		}
		return executeReuseMode(executeCtx, params.reuseLabel!, params.task);
	}

	if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
		const denied = await confirmProjectAgentsIfNeeded(
			ctx,
			params,
			agents,
			discovery.projectAgentsDir,
			hasChain,
			hasTasks,
			makeDetails,
		);
		if (denied) return denied;
	}

	if (params.chain && params.chain.length > 0) {
		return executeChainMode(executeCtx, params.chain);
	}

	if (params.tasks && params.tasks.length > 0) {
		return executeParallelMode(executeCtx, params.tasks);
	}

	if (params.agent && params.task) {
		return executeSingleMode(executeCtx, params.agent, params.task, params.cwd);
	}

	return invalidParamsResponse(agents, makeDetails, "Invalid parameters. Available agents: {available}");
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}
