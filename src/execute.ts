import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { StringEnum } from '@earendil-works/pi-ai';
import { getAgentDir, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { discoverAgents } from './agents.ts';
import type { AgentConfig, AgentScope } from './agents.ts';
import { getConfig } from './config.ts';
import {
	deriveFlowId,
	evidenceScopeForRole,
	orchestrationFromEntry,
	sanitizeCriteria,
	sanitizeReviewScope,
	sanitizeTaskId,
} from './delegation.ts';
import { applyOutputByteCap, getFinalOutput, getResultOutput, isFailedResult } from './format.ts';
import { NESTED, ownWorkspaceId } from './herdr.ts';
import {
	type FindModel,
	effectivePresetName,
	filterAvailableModels,
	findModelFrom,
	readPresetOverride,
} from './presets.ts';
import { findEntry, listSubagents } from './registry.ts';
import { runReusedAgent, runSingleAgent } from './run.ts';
import { ensureReviewSurface } from './scope.ts';
import { outsideRootCwds } from './spawn-boundary.ts';
import { REUSE_WORKFLOW_GUIDANCE } from './templates.ts';
import { appendCompositionTelemetry, appendS4PreflightTelemetry } from './telemetry.ts';
import { makeEmptyUsage } from './types.ts';
import { COMPOSITION_RULES } from './types.ts';
import type {
	BlockEventInfo,
	CompositionPolicy,
	CompositionVerdict,
	OnUpdateCallback,
	OrchestrationContext,
	ReviewScope,
	SingleResult,
	SubagentDetails,
	SubagentRefusal,
	S4CompositionObservation,
	S4Preflight,
} from './types.ts';

const ReviewScope = Type.Object({
	paths: Type.Optional(
		Type.Array(Type.String({ maxLength: 512, description: 'In-scope repository paths' }), {
			maxItems: 100,
		}),
	),
	hunks: Type.Optional(
		Type.Array(Type.String({ maxLength: 512, description: 'In-scope diff hunk identifiers' }), {
			maxItems: 100,
		}),
	),
	outOfScope: Type.Optional(
		Type.Array(
			Type.String({ maxLength: 512, description: 'Repository areas explicitly out of scope' }),
			{
				maxItems: 100,
			},
		),
	),
});

const TaskItem = Type.Object({
	agent: Type.String({ description: 'Name of the agent to invoke' }),
	task: Type.String({ description: 'Task to delegate to the agent' }),
	cwd: Type.Optional(
		Type.String({
			description:
				'Working directory for the agent process (must be inside the root session folder)',
		}),
	),
	scope: Type.Optional(ReviewScope),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: 'Name of the agent to invoke' }),
	task: Type.String({ description: 'Task with optional {previous} placeholder for prior output' }),
	cwd: Type.Optional(
		Type.String({
			description:
				'Working directory for the agent process (must be inside the root session folder)',
		}),
	),
	scope: Type.Optional(ReviewScope),
});

const AgentScopeSchema = StringEnum(['user', 'project', 'both'] as const, {
	description:
		'Which agent directories to use. Default: "user" (or config defaultAgentScope). Use "both" to include project-local agents.',
	default: 'user',
});

const SUBAGENT_PARAMETER_PROPERTIES = {
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
		Type.String({
			description:
				'Working directory for the agent process (single mode; must be inside the root session folder)',
		}),
	),
	listSubagents: Type.Optional(
		Type.Boolean({
			description: `${REUSE_WORKFLOW_GUIDANCE} Each entry shows the exact bare label to pass as reuseLabel.`,
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
			description:
				'With listSubagents: include pane, session-file, and expanded last-result diagnostics instead of the compact listing',
		}),
	),
	agents: Type.Optional(
		Type.Boolean({
			description:
				'List available agents (name, description, source) for the current agentScope; call this before picking an agent name',
		}),
	),
	taskId: Type.Optional(
		Type.String({
			description:
				'Stable task identity for this work (for example "T-001"), reused by every remediation attempt of the same work. Recorded in the flow ledger and exported to the child as PI_ORCHESTRATION_TASK. Attempt numbers are counted from the ledger, so do not track them here.',
		}),
	),
	tier: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: 4,
			description:
				'Orchestration tier of this delegation (0-4). Recorded for measurement and exported to the child as PI_ORCHESTRATION_TIER; it does not change tool behaviour.',
		}),
	),
	workflowMode: Type.Optional(
		StringEnum(['initial', 'remediation'] as const, {
			description:
				'Whether this delegation starts work or remediates a prior attempt. Recorded and exported as PI_ORCHESTRATION_MODE; it does not change tool behaviour.',
		}),
	),
	reviewMode: Type.Optional(
		StringEnum(['primary', 'security', 'validation', 'remediation'] as const, {
			description:
				'Which kind of review this delegation performs. Recorded and exported as PI_ORCHESTRATION_REVIEW_MODE.',
		}),
	),
	acceptanceCriteria: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'Acceptance-criteria ids this delegation must satisfy (for example ["AC-001","AC-002"]). Recorded and exported to the child as PI_ORCHESTRATION_CRITERIA.',
		}),
	),
	scope: Type.Optional(ReviewScope),
	evidenceScope: Type.Optional(
		StringEnum(['session', 'flow'] as const, {
			description:
				'How independence is requested for this delegation. The default scope is flow for every role, so a child resolves sibling refs; narrowing to session stops the child resolving sibling refs, so it must execute its own checks. May only narrow the scope configured for the role, never widen it.',
		}),
	),
	reuseLabel: Type.Optional(
		Type.String({
			description: `${REUSE_WORKFLOW_GUIDANCE} Continue the selected session in place (preserving its context); send task as the next message.`,
		}),
	),
};

export const SubagentParams = Type.Object(SUBAGENT_PARAMETER_PROPERTIES);

const CompositionPolicyOverride = StringEnum(['warn', 'enforce', 'off'] as const, {
	description:
		'Deliberate per-call composition policy override. Use this only through subagent_override; normal subagent delegations use the configured policy.',
});

export const SubagentOverrideParams = Type.Object({
	...SUBAGENT_PARAMETER_PROPERTIES,
	compositionPolicy: CompositionPolicyOverride,
});

export type SubagentParams = Static<typeof SubagentParams>;
export type SubagentOverrideParams = Static<typeof SubagentOverrideParams>;
export type SubagentExecutionParams = SubagentParams & {
	compositionPolicy?: CompositionPolicy;
};

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
	presetName: string | undefined;
	presetModels: Record<string, string>;
	cwd: string;
	signal: AbortSignal | undefined;
	onUpdate: OnUpdateCallback | undefined;
	onBlocked: ((info: BlockEventInfo) => void) | undefined;
	orchestration: OrchestrationContext;
	s4BoundaryId?: string;
	s4TaskId?: string;
}

function makeDetailsFor(ctx: ExecuteContext) {
	return (mode: 'single' | 'parallel' | 'chain') =>
		(results: SingleResult[], refusal?: SubagentRefusal): SubagentDetails => ({
			mode,
			agentScope: ctx.agentScope,
			projectAgentsDir: ctx.projectAgentsDir,
			results,
			...(refusal ? { refusal } : {}),
		});
}

function isCompositionPolicy(value: unknown): value is CompositionPolicy {
	return value === 'warn' || value === 'enforce' || value === 'off';
}

function orchestrationFromParams(
	params: SubagentExecutionParams,
	compositionPolicy: CompositionPolicy,
	compositionPolicyOverride?: CompositionPolicy,
): OrchestrationContext {
	const orchestration: OrchestrationContext = compositionPolicyOverride
		? { compositionPolicy, compositionPolicyOverride }
		: { compositionPolicy };
	if (params.taskId) {
		const taskId = sanitizeTaskId(params.taskId);
		if (taskId) orchestration.taskId = taskId;
	}
	if (typeof params.tier === 'number') orchestration.tier = params.tier;
	if (params.workflowMode) orchestration.workflowMode = params.workflowMode;
	if (params.reviewMode) orchestration.reviewMode = params.reviewMode;
	if (params.acceptanceCriteria?.length)
		orchestration.acceptanceCriteria = sanitizeCriteria(params.acceptanceCriteria);
	if (params.scope) orchestration.scope = params.scope;
	if (params.evidenceScope) orchestration.evidenceScope = params.evidenceScope;
	return orchestration;
}

function buildExecuteContext(
	params: SubagentExecutionParams,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	ctx: ExtensionContext,
): { executeCtx: ExecuteContext; makeDetails: ReturnType<typeof makeDetailsFor> } {
	const cfg = getConfig();
	const compositionPolicyOverride = isCompositionPolicy(params.compositionPolicy)
		? params.compositionPolicy
		: undefined;
	const compositionPolicy = compositionPolicyOverride ?? cfg.compositionPolicy;
	const agentScope: AgentScope = params.agentScope ?? cfg.defaultAgentScope;
	const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
	const discovery = discoverAgents(ctx.cwd, agentScope);
	const findModel: FindModel | undefined = findModelFrom(ctx.modelRegistry);
	const presetName = effectivePresetName(readPresetOverride(ctx.sessionManager), cfg);
	const presetModels = presetName
		? filterAvailableModels(cfg.modelPresets[presetName], findModel).available
		: (Object.create(null) as Record<string, string>);
	const executeCtx: ExecuteContext = {
		agentScope,
		sessionFile,
		agents: discovery.agents,
		projectAgentsDir: discovery.projectAgentsDir,
		presetName,
		presetModels,
		cwd: ctx.cwd,
		signal,
		onUpdate,
		onBlocked: buildOnBlocked(ctx),
		orchestration: orchestrationFromParams(params, compositionPolicy, compositionPolicyOverride),
	};
	return { executeCtx, makeDetails: makeDetailsFor(executeCtx) };
}

function invalidParamsResponse(
	agents: AgentConfig[],
	makeDetails: ReturnType<typeof makeDetailsFor>,
	text: string,
): AgentToolResult<SubagentDetails> {
	const available = agents.map((a) => `${a.name} (${a.source})`).join(', ') || 'none';
	const message = text.replace('{available}', available);
	return {
		content: [{ type: 'text', text: message }],
		details: makeDetails('single')([], { kind: 'invalid-params', message }),
		isError: true,
	};
}

function spawnBoundaryRefusalText(
	rootCwd: string,
	params: SubagentExecutionParams,
): string | undefined {
	const offenders = outsideRootCwds(rootCwd, [
		params.cwd,
		...(params.tasks ?? []).map((task) => task.cwd),
		...(params.chain ?? []).map((step) => step.cwd),
	]);
	if (offenders.length === 0) return undefined;
	const lines = offenders.map(
		(o) =>
			`cwd '${o.raw}' resolves to '${o.resolved}', which is outside this session's root folder '${rootCwd}'.`,
	);
	return [
		'Spawn boundary refusal: no child was launched.',
		...lines,
		'Subagents may only be spawned inside the root session folder; subfolders of the root are allowed.',
		'Remove the cwd parameter or pass a path inside the root folder, then re-run.',
	].join('\n');
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
			ctx.presetModels,
			{
				...ctx.orchestration,
				...(step.scope ? { scope: step.scope } : {}),
			},
			ctx.s4BoundaryId,
			ctx.s4TaskId,
		);
		results.push(result);

		const isError = isFailedResult(result);
		if (isError) {
			const errorMsg = getResultOutput(result);
			return {
				content: [
					{
						type: 'text',
						text: withCompositionWarnings(
							appendChainReuseLabels(
								`Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`,
								results,
							),
							ctx,
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
				text: withCompositionWarnings(
					appendChainReuseLabels(deliverableText(results[results.length - 1]), results),
					ctx,
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
	effectiveScope: ReviewScope | undefined,
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
		ctx.presetModels,
		task.scope === undefined
			? {
					...ctx.orchestration,
					...(effectiveScope ? { scope: effectiveScope } : {}),
				}
			: { ...ctx.orchestration, scope: effectiveScope },
		ctx.s4BoundaryId,
		ctx.s4TaskId,
	);
	allResults[index] = result;
	emitUpdate();
	return result;
}

/** Under this many estimated tokens a reply is an acknowledgement, not a report to police. */
const CONTRACT_NOTE_MIN_TOKENS = 64;

/**
 * Text a delegation hands back to the parent: the bounded digest when one was built,
 * otherwise the raw output, always inside the configured byte cap.
 */
function deliverableText(result: SingleResult, fallback?: string): string {
	const report = result.report;
	if (!report)
		return applyOutputByteCap((fallback ?? getFinalOutput(result.messages)) || '(no output)');
	const parts = [report.digest || (fallback ?? '(no output)')];
	const notes: string[] = [];
	if (report.path) notes.push(`full report: ${report.path}`);
	if (result.ledgerRevision !== undefined) notes.push(`ledger rev ${result.ledgerRevision}`);
	if (notes.length > 0) parts.push(`[${notes.join('; ')}]`);
	// A short acknowledgement has no report shape to enforce; the note would be pure noise.
	if (!report.ledgerParsed && report.tokens >= CONTRACT_NOTE_MIN_TOKENS) {
		parts.push(
			getConfig().reportContractPolicy === 'reject'
				? '[Report contract FAILED: the child returned no orchestration ledger block. Treat this delegation as unfinished: request the ledger or re-delegate.]'
				: `[Report contract: no ledger block parsed from ~${report.tokens} tokens of report.]`,
		);
	}
	if (report.contractIssues?.length) {
		const issue = report.contractIssues.join('; ');
		parts.push(
			getConfig().reportContractPolicy === 'reject'
				? `[Report contract FAILED: ${issue}. Treat this delegation as unfinished: request the required section or re-delegate.]`
				: `[Report contract: ${issue}.]`,
		);
	}
	return applyOutputByteCap(parts.filter((part) => part.trim()).join('\n\n'));
}

function parallelSummaryText(results: SingleResult[]): string {
	const successCount = results.filter((r) => !isFailedResult(r)).length;
	const summaries = results.map((r) => {
		const output = deliverableText(r, getResultOutput(r));
		const status = isFailedResult(r)
			? `failed${r.stopReason && r.stopReason !== 'end' ? ` (${r.stopReason})` : ''}`
			: 'completed';
		const label = r.label ? `\n\nreuseLabel: ${r.label}` : '';
		return `### [${r.label ?? r.agent}] ${status}${label}\n\n${output}`;
	});
	return `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join('\n\n---\n\n')}`;
}

function scopesOverlap(left: string, right: string): boolean {
	return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function disjointScopeError(scopes: (ReviewScope | undefined)[]): string | undefined {
	for (let i = 0; i < scopes.length; i++) {
		const left = scopes[i]?.paths ?? [];
		for (let j = i + 1; j < scopes.length; j++) {
			const right = scopes[j]?.paths ?? [];
			const overlap = left.find((scopePath) =>
				right.some((other) => scopesOverlap(scopePath, other)),
			);
			if (overlap)
				return `Parallel review scopes overlap at ${overlap}; assign disjoint paths before fan-out.`;
		}
	}
	return undefined;
}

interface CompositionEvaluation {
	warnings: CompositionVerdict[];
	refusals: CompositionVerdict[];
	preflight: S4Preflight;
}

function compositionRule(id: CompositionVerdict['rule']) {
	return COMPOSITION_RULES.find((rule) => rule.id === id)!;
}

function makeCompositionVerdict(
	policy: CompositionPolicy,
	mode: 'single' | 'parallel' | 'chain',
	ruleId: CompositionVerdict['rule'],
	input: Pick<CompositionVerdict, 'agent' | 'role' | 'tier' | 'scope'>,
	reason: string,
): CompositionVerdict {
	const action = policy === 'enforce' ? 'refuse' : 'warn';
	const rule = compositionRule(ruleId);
	return {
		rule: ruleId,
		action,
		verdict: action === 'refuse' ? 'refusal' : 'warning',
		policy,
		mode,
		...input,
		reason,
		compliantAlternative: rule.alternative,
	};
}

function evaluateComposition(
	ctx: ExecuteContext,
	mode: 'single' | 'parallel' | 'chain',
	input:
		| { agent: string; scope?: ReviewScope }
		| { tasks: Static<typeof TaskItem>[] }
		| { chain: Static<typeof ChainItem>[] },
): CompositionEvaluation {
	const policy = ctx.orchestration.compositionPolicy ?? getConfig().compositionPolicy;
	const policyOverride = ctx.orchestration.compositionPolicyOverride;
	const decisionSource = policyOverride ? 'override' : 'default';
	const boundaryId = randomUUID();
	const items = 'agent' in input ? [input] : 'tasks' in input ? input.tasks : input.chain;
	const expectedChildCount = items.length;
	const tier = ctx.orchestration.tier;
	const verdicts: CompositionVerdict[] = [];
	// This must remain an array: a chain can contain several eligible R1/R3/R4
	// candidates, and each candidate is part of the S4 denominator.
	const observations: S4CompositionObservation[] = [];
	const eligibleRules = new Set<S4CompositionObservation['ruleId']>();
	const addObservation = (
		ruleId: S4CompositionObservation['ruleId'],
		eligible: boolean,
		compliant: boolean | null,
		action: S4CompositionObservation['action'],
		reason: string,
	) => {
		if (eligible) eligibleRules.add(ruleId);
		observations.push({
			ruleId,
			eligible,
			compliant,
			action,
			decisionSource,
			reason,
			compositionBoundaryId: boundaryId,
			mode,
			policy,
			...(policyOverride ? { policyOverride } : {}),
			expectedChildCount,
		});
	};
	const violation = (
		ruleId: CompositionVerdict['rule'],
		reason: string,
		agent: string,
		scope?: ReviewScope,
	) => {
		verdicts.push(
			makeCompositionVerdict(
				policy,
				mode,
				ruleId,
				{
					agent,
					role: agent,
					...(tier !== undefined ? { tier } : {}),
					...(scope ? { scope } : {}),
				},
				reason,
			),
		);
	};

	const reviewers =
		mode === 'parallel' && 'tasks' in input
			? input.tasks.filter((task) => task.agent === 'reviewer')
			: [];
	const reviewerScopes = reviewers.map((task) => sanitizeReviewScope(task.scope));
	const r2Eligible = mode === 'parallel' && reviewers.length > 1;
	const r2Compliant = r2Eligible
		? reviewerScopes.every((scope) => Boolean(scope?.paths?.length)) &&
			disjointScopeError(reviewerScopes) === undefined
		: null;
	const r2Reason = !r2Eligible
		? 'R2 applies only to an actual parallel fan-out containing more than one reviewer.'
		: r2Compliant
			? 'Parallel reviewers have explicit non-empty, disjoint scope.paths lists.'
			: reviewerScopes.some((scope) => !scope?.paths?.length)
				? 'One or more real parallel reviewers is missing a non-empty scope.paths list.'
				: 'Real parallel reviewer scope.paths overlap.';
	if (r2Eligible) {
		addObservation(
			'R2',
			true,
			r2Compliant,
			r2Compliant
				? 'allow'
				: policy === 'off'
					? 'disabled'
					: policy === 'enforce'
						? 'refuse'
						: 'warn',
			r2Reason,
		);
		if (!r2Compliant && policy !== 'off')
			violation(
				'R2',
				r2Reason,
				'reviewer',
				reviewerScopes.find((scope) => scope !== undefined),
			);
	}

	const checkAgent = (agent: string, scope: ReviewScope | undefined, index: number) => {
		const completedPlanner =
			mode === 'chain' &&
			'chain' in input &&
			input.chain.slice(0, index).some((previous) => previous.agent === 'planner');
		if (agent === 'validator' && tier === 1) {
			const reason =
				'Tier 1 validation is already covered by the worker verify ref; delegating another validator duplicates the deterministic gate.';
			addObservation(
				'R1',
				true,
				false,
				policy === 'off' ? 'disabled' : policy === 'enforce' ? 'refuse' : 'warn',
				reason,
			);
			if (policy !== 'off') violation('R1', reason, agent, scope);
		}
		if (agent === 'validator' && tier !== undefined && tier <= 2 && tier !== 1) {
			const cfg = getConfig();
			const configuredScope = evidenceScopeForRole('validator', {
				evidenceScopeDefault: cfg.evidenceScopeDefault,
				evidenceScopeByRole: cfg.evidenceScopeByRole,
			});
			const effectiveScope =
				ctx.orchestration.evidenceScope === 'session' ? 'session' : configuredScope;
			const compliant = effectiveScope === 'session';
			const reason = compliant
				? 'Validator uses session evidence scope for an independent validation run.'
				: `Validator tier ${tier} without evidenceScope: "session" resolves the flow/default lookup instead of independently executing the gate.`;
			addObservation(
				'R3',
				true,
				compliant,
				policy === 'off'
					? 'disabled'
					: compliant
						? 'allow'
						: policy === 'enforce'
							? 'refuse'
							: 'warn',
				reason,
			);
			if (!compliant && policy !== 'off') violation('R3', reason, agent, scope);
		}
		if (agent === 'worker' && tier === 3) {
			const compliant = completedPlanner;
			const reason = compliant
				? 'A planner completed earlier in this sequential chain.'
				: mode === 'parallel'
					? 'Tier 3 worker in a parallel fan-out has no completed planner; array order does not establish precedence.'
					: 'Tier 3 worker has no preceding planner in this composition, so the required investigation plan is missing.';
			addObservation(
				'R4',
				true,
				compliant,
				policy === 'off'
					? 'disabled'
					: compliant
						? 'allow'
						: policy === 'enforce'
							? 'refuse'
							: 'warn',
				reason,
			);
			if (!compliant && policy !== 'off') violation('R4', reason, agent, scope);
		}
	};
	if ('agent' in input)
		checkAgent(input.agent, sanitizeReviewScope(input.scope ?? ctx.orchestration.scope), 0);
	else
		items.forEach((item, index) =>
			checkAgent(item.agent, sanitizeReviewScope(item.scope ?? ctx.orchestration.scope), index),
		);
	for (const rule of COMPOSITION_RULES) {
		if (!observations.some((observation) => observation.ruleId === rule.id))
			addObservation(
				rule.id,
				false,
				null,
				policy === 'off' && eligibleRules.has(rule.id) ? 'disabled' : 'not_applicable',
				`No real eligible ${rule.id} candidate was present at this boundary.`,
			);
	}
	const finalExpectedChildCount = verdicts.some((verdict) => verdict.action === 'refuse')
		? 0
		: expectedChildCount;
	return {
		warnings: verdicts.filter((verdict) => verdict.action === 'warn'),
		refusals: verdicts.filter((verdict) => verdict.action === 'refuse'),
		preflight: {
			v: 1,
			compositionBoundaryId: boundaryId,
			mode,
			policy,
			...(policyOverride ? { policyOverride } : {}),
			expectedChildCount: finalExpectedChildCount,
			observations: observations.map((observation) =>
				Object.assign({}, observation, { expectedChildCount: finalExpectedChildCount }),
			),
		},
	};
}

function compositionWarningText(verdicts: CompositionVerdict[]): string {
	return verdicts
		.map(
			(verdict) =>
				`Composition warning [${verdict.rule}] ${verdict.agent ?? verdict.role ?? 'delegation'}: ${verdict.reason} Compliant alternative: ${verdict.compliantAlternative}`,
		)
		.join('\n');
}

function withCompositionWarnings(text: string, ctx: ExecuteContext): string {
	const warnings = ctx.orchestration.compositionVerdicts?.filter(
		(verdict) => verdict.action === 'warn',
	);
	return warnings?.length ? `${compositionWarningText(warnings)}\n\n${text}` : text;
}

function compositionRefusalResponse(
	ctx: ExecuteContext,
	mode: 'single' | 'parallel' | 'chain' | 'reuse',
	refusals: CompositionVerdict[],
	makeDetails: ReturnType<typeof makeDetailsFor>,
	boundaryId?: string,
): AgentToolResult<SubagentDetails> {
	appendCompositionTelemetry({
		verdicts: refusals,
		workspace: ownWorkspaceId(),
		parentSession: ctx.sessionFile,
		flowId: deriveFlowId(ctx.sessionFile),
		policy:
			ctx.orchestration.compositionPolicy ?? refusals[0]?.policy ?? getConfig().compositionPolicy,
		policyOverride: ctx.orchestration.compositionPolicyOverride,
		boundaryId,
	});
	const refusalText = compositionWarningText(refusals).replaceAll(
		'Composition warning',
		'Composition refusal',
	);
	return {
		content: [{ type: 'text', text: refusalText }],
		details: makeDetails(mode === 'reuse' ? 'single' : mode)([], {
			kind: 'composition',
			message: refusalText,
		}),
		isError: true,
	};
}

async function executeParallelMode(
	ctx: ExecuteContext,
	tasks: Static<typeof TaskItem>[],
): Promise<AgentToolResult<SubagentDetails>> {
	const makeDetails = makeDetailsFor(ctx);
	const maxParallelTasks = getConfig().maxParallelTasks;
	if (tasks.length > maxParallelTasks) {
		const message = `Too many parallel tasks (${tasks.length}). Max is ${maxParallelTasks}.`;
		return {
			content: [{ type: 'text', text: message }],
			details: makeDetails('parallel')([], { kind: 'too-many-tasks', message }),
			isError: true,
		};
	}
	const effectiveScopes = tasks.map((task) =>
		sanitizeReviewScope(task.scope ?? ctx.orchestration.scope),
	);
	const scopeError = disjointScopeError(effectiveScopes);
	if (scopeError)
		return {
			content: [{ type: 'text', text: scopeError }],
			details: makeDetails('parallel')([], { kind: 'overlapping-scope', message: scopeError }),
			isError: true,
		};

	const flowId = deriveFlowId(ctx.sessionFile);
	const reviewSurface = ensureReviewSurface(flowId, ctx.cwd);
	const fanOutContext = reviewSurface
		? {
				...ctx,
				orchestration: {
					...ctx.orchestration,
					reviewSurfacePath: reviewSurface.path,
					reviewSurfaceRevision: reviewSurface.revision,
					reviewSurfaceRefreshed: reviewSurface.refreshed,
					reviewSurfaceHead: reviewSurface.head,
					dirtyPaths: reviewSurface.dirtyPaths,
				},
			}
		: ctx;
	const allResults = initParallelResults(tasks);
	const emitUpdate = makeParallelUpdateEmit(fanOutContext, allResults, makeDetails);
	const results = await mapWithConcurrencyLimit(tasks, getConfig().maxConcurrency, (task, index) =>
		runParallelTask(
			fanOutContext,
			task,
			index,
			allResults,
			emitUpdate,
			makeDetails,
			effectiveScopes[index],
		),
	);
	return {
		content: [
			{ type: 'text', text: withCompositionWarnings(parallelSummaryText(results), fanOutContext) },
		],
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
		ctx.presetModels,
		ctx.orchestration,
		ctx.s4BoundaryId,
		ctx.s4TaskId,
	);
	const isError = isFailedResult(result);
	if (isError) {
		const errorMsg = getResultOutput(result);
		return {
			content: [
				{
					type: 'text',
					text: withCompositionWarnings(
						appendReuseLabel(`Agent ${result.stopReason || 'failed'}: ${errorMsg}`, result.label),
						ctx,
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
				text: withCompositionWarnings(appendReuseLabel(deliverableText(result), result.label), ctx),
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
		ctx.presetModels,
		ctx.orchestration,
		ctx.s4BoundaryId,
		ctx.s4TaskId,
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
				text: appendReuseLabel(deliverableText(result), result.label ?? reuseLabel),
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
	const message = 'Canceled: project-local agents not approved.';
	return {
		content: [{ type: 'text', text: message }],
		details: makeDetails(hasChain ? 'chain' : hasTasks ? 'parallel' : 'single')([], {
			kind: 'project-agents-denied',
			message,
		}),
		isError: true,
	};
}

function nestedResponse(
	mode: SubagentMode,
	makeDetails: ReturnType<typeof makeDetailsFor>,
): AgentToolResult<SubagentDetails> {
	const message =
		'Nested subagents are disabled: this session is itself a subagent (PI_SUBAGENT_NESTED is set), so it cannot spawn its own subagents.';
	return {
		content: [{ type: 'text', text: message }],
		details: makeDetails(mode as 'single')([], { kind: 'nested', message }),
		isError: true,
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
		const model = ctx.presetModels[a.name];
		const modelText = model ? `, model: ${model}` : ', model: (pi default)';
		return `- ${a.name} (${a.source}) - ${a.description}${modelText}`;
	});
	return {
		content: [
			{
				type: 'text',
				text: `Available agents (agentScope: ${ctx.agentScope}, model preset: ${ctx.presetName ?? 'none'}):\n${lines.join('\n')}\n\nPick the agent whose description best fits the task and use its exact name; do not invent agent names.`,
			},
		],
		details: makeDetails('single')([]),
	};
}

function reuseWithoutTaskResponse(
	makeDetails: ReturnType<typeof makeDetailsFor>,
): AgentToolResult<SubagentDetails> {
	const message =
		'Invalid parameters. reuseLabel requires a task (the next message for that session).';
	return {
		content: [{ type: 'text', text: message }],
		details: makeDetails('single')([], { kind: 'reuse-without-task', message }),
		isError: true,
	};
}

function sessionOwnerUnavailableResponse(
	makeDetails: ReturnType<typeof makeDetailsFor>,
): AgentToolResult<SubagentDetails> {
	const message =
		'Subagent session ownership is unavailable: the current Pi session has no session file, so listing and reuse are unavailable.';
	return {
		content: [{ type: 'text', text: message }],
		details: makeDetails('single')([], { kind: 'session-unavailable', message }),
		isError: true,
	};
}

// fallow-ignore-next-line complexity
export async function executeSubagent(
	params: SubagentExecutionParams,
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
	if (mode === 'single' || mode === 'parallel' || mode === 'chain') {
		const spawnRefusal = spawnBoundaryRefusalText(executeCtx.cwd, params);
		if (spawnRefusal) {
			return {
				content: [{ type: 'text', text: spawnRefusal }],
				details: makeDetails(mode)([], { kind: 'spawn-boundary', message: spawnRefusal }),
				isError: true,
			};
		}
	}
	if (mode === 'reuse' && !params.task) return reuseWithoutTaskResponse(makeDetails);
	const reuseEntry =
		mode === 'reuse' ? findEntry(params.reuseLabel!, executeCtx.sessionFile) : undefined;
	const compositionCtx =
		mode === 'reuse' && reuseEntry
			? {
					...executeCtx,
					orchestration: {
						...orchestrationFromEntry(reuseEntry),
						...executeCtx.orchestration,
					},
				}
			: executeCtx;
	const composition =
		mode === 'single'
			? evaluateComposition(compositionCtx, mode, {
					agent: params.agent!,
					scope: params.scope,
				})
			: mode === 'parallel'
				? evaluateComposition(compositionCtx, mode, { tasks: params.tasks! })
				: mode === 'chain'
					? evaluateComposition(compositionCtx, mode, { chain: params.chain! })
					: evaluateComposition(compositionCtx, 'single', {
							agent: reuseEntry?.agent ?? 'reuse',
							scope: params.scope,
						});
	const s4TaskId =
		compositionCtx.orchestration.taskId ??
		`s4-${composition.preflight.compositionBoundaryId.replaceAll('-', '').slice(0, 28)}`;
	const childCtx: ExecuteContext = {
		...compositionCtx,
		s4BoundaryId: composition.preflight.compositionBoundaryId,
		s4TaskId,
		orchestration: {
			...compositionCtx.orchestration,
			...(composition.warnings.length > 0 ? { compositionVerdicts: composition.warnings } : {}),
			...(compositionCtx.orchestration.compositionBoundaryId
				? {}
				: { compositionBoundaryId: composition.preflight.compositionBoundaryId }),
		},
	};
	const s4FlowId =
		mode === 'reuse'
			? (reuseEntry?.flowId ?? deriveFlowId(executeCtx.sessionFile))
			: deriveFlowId(executeCtx.sessionFile);
	appendS4PreflightTelemetry({
		preflight: composition.preflight,
		workspace: ownWorkspaceId(),
		parentSession: executeCtx.sessionFile,
		flowId: s4FlowId,
		taskId: s4TaskId,
		tier: compositionCtx.orchestration.tier,
	});
	if (composition.refusals.length > 0) {
		return compositionRefusalResponse(
			compositionCtx,
			mode,
			composition.refusals,
			makeDetails,
			composition.preflight.compositionBoundaryId,
		);
	}
	if (composition.warnings.length > 0) {
		appendCompositionTelemetry({
			verdicts: composition.warnings,
			workspace: ownWorkspaceId(),
			parentSession: executeCtx.sessionFile,
			flowId: deriveFlowId(executeCtx.sessionFile),
			policy: compositionCtx.orchestration.compositionPolicy ?? composition.warnings[0].policy,
			policyOverride: compositionCtx.orchestration.compositionPolicyOverride,
			boundaryId: composition.preflight.compositionBoundaryId,
		});
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
	if (mode === 'chain') return executeChainMode(childCtx, params.chain!);
	if (mode === 'parallel') return executeParallelMode(childCtx, params.tasks!);
	if (mode === 'reuse') return executeReuseMode(childCtx, params.reuseLabel!, params.task!);
	return executeSingleMode(childCtx, params.agent!, params.task!, params.cwd);
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
