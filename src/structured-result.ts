import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import type { AgentScope } from './agents.ts';
import type {
	BlockReason,
	HerdrStatus,
	SingleResult,
	SubagentDetails,
	SubagentRefusal,
} from './types.ts';

/**
 * Bounded structured results for the subagent tools (S13-001).
 *
 * The runtime feeds `structuredContent` to programmatic callers such as codemode scripts for tools
 * that declare an `outputSchema`, so those callers never have to parse the model-facing text. The
 * projection here is intentionally smaller than {@link SubagentDetails}: transcripts, stderr, read
 * manifests, dirty paths, and internal metrics never leave the session.
 *
 * A refused call is an `isError: true` result that keeps its model-facing text and adds a bounded
 * {@link SubagentRefusal} here, so a caller can tell a refusal apart from an empty success. Keep the
 * projection and {@link SubagentStructuredResultSchema} in sync: every bounded field here must be
 * declared there with the same limit. The schema sets `additionalProperties: false`, so tests fail
 * when the projection and the declaration drift apart.
 */

/** Parallel results beyond this cap are reported as `truncated` instead of passed through. */
export const MAX_STRUCTURED_RESULTS = 32;
const MAX_ID_LENGTH = 128;
const MAX_ERROR_MESSAGE_LENGTH = 300;
const MAX_STOP_REASON_LENGTH = 100;
const MAX_REFUSAL_MESSAGE_LENGTH = 600;

export interface SubagentStructuredUsage {
	input: number;
	output: number;
	contextTokens: number;
	cost: number;
	turns: number;
}

export interface SubagentStructuredResultItem {
	label?: string;
	agent: string;
	agentSource: 'user' | 'project' | 'unknown' | 'reuse';
	exitCode: number;
	stopReason?: string;
	errorMessage?: string;
	herdrStatus?: HerdrStatus;
	steered?: boolean;
	blockReason?: BlockReason;
	step?: number;
	delegationId?: string;
	taskId?: string;
	usage?: SubagentStructuredUsage;
}

export interface SubagentStructuredResult {
	mode: 'single' | 'parallel' | 'chain';
	agentScope: AgentScope;
	results: SubagentStructuredResultItem[];
	/** Present when the call was refused; `results` is then always empty. */
	refusal?: SubagentRefusal;
	/** True when the results array was capped at {@link MAX_STRUCTURED_RESULTS}. */
	truncated?: boolean;
}

function cap(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function itemOf(result: SingleResult): SubagentStructuredResultItem {
	const item: SubagentStructuredResultItem = {
		agent: cap(result.agent, MAX_ID_LENGTH),
		agentSource: result.agentSource,
		exitCode: result.exitCode,
	};
	if (result.label) item.label = cap(result.label, MAX_ID_LENGTH);
	if (result.stopReason) item.stopReason = cap(result.stopReason, MAX_STOP_REASON_LENGTH);
	if (result.errorMessage) item.errorMessage = cap(result.errorMessage, MAX_ERROR_MESSAGE_LENGTH);
	if (result.herdrStatus) item.herdrStatus = result.herdrStatus;
	if (result.steered !== undefined) item.steered = result.steered;
	if (result.blockReason) item.blockReason = result.blockReason;
	if (result.step !== undefined) item.step = result.step;
	if (result.delegationId) item.delegationId = cap(result.delegationId, MAX_ID_LENGTH);
	if (result.taskId) item.taskId = cap(result.taskId, MAX_ID_LENGTH);
	if (result.usage) {
		item.usage = {
			input: result.usage.input,
			output: result.usage.output,
			contextTokens: result.usage.contextTokens,
			cost: result.usage.cost,
			turns: result.usage.turns,
		};
	}
	return item;
}

/** Bounded projection of `SubagentDetails`, matching {@link SubagentStructuredResultSchema}. */
export function structuredContentOf(details: SubagentDetails): SubagentStructuredResult {
	const results = details.results.slice(0, MAX_STRUCTURED_RESULTS).map(itemOf);
	return {
		mode: details.mode,
		agentScope: details.agentScope,
		results,
		...(details.results.length > results.length ? { truncated: true } : {}),
		...(details.refusal
			? {
					refusal: {
						kind: details.refusal.kind,
						message: cap(details.refusal.message, MAX_REFUSAL_MESSAGE_LENGTH),
					},
				}
			: {}),
	};
}

/**
 * Attaches `structuredContent` to a tool result without touching the model-facing content, the
 * details, or the `isError` flag.
 */
export function withStructuredContent<T extends SubagentDetails>(
	result: AgentToolResult<T>,
): AgentToolResult<T> & { structuredContent: SubagentStructuredResult } {
	return Object.assign({}, result, { structuredContent: structuredContentOf(result.details) });
}

const StructuredMode = StringEnum(['single', 'parallel', 'chain'] as const, {
	description: 'Which subagent mode produced the results.',
});
const StructuredAgentScope = StringEnum(['user', 'project', 'both'] as const, {
	description: 'Agent directories the call could use.',
});
const StructuredAgentSource = StringEnum(['user', 'project', 'unknown', 'reuse'] as const, {
	description: 'Where the agent definition came from, or that the session was reused.',
});
const StructuredHerdrStatus = StringEnum(
	['unknown', 'working', 'idle', 'blocked', 'done'] as const,
	{
		description: 'Last known herdr session status.',
	},
);
const StructuredBlockReason = StringEnum(['approval', 'steer'] as const, {
	description: 'Why the subagent was blocked, when it was blocked.',
});
const StructuredRefusalKind = StringEnum(
	[
		'invalid-params',
		'nested',
		'session-unavailable',
		'spawn-boundary',
		'overlapping-scope',
		'too-many-tasks',
		'composition',
		'project-agents-denied',
		'reuse-without-task',
	] as const,
	{ description: 'Why the call was refused before any child ran.' },
);

const StructuredUsageSchema = Type.Object(
	{
		input: Type.Number({ description: 'Input tokens of the turn.' }),
		output: Type.Number({ description: 'Output tokens of the turn.' }),
		contextTokens: Type.Number({
			description: 'Context size at the end of the turn; large values favour a fresh session.',
		}),
		cost: Type.Number({ description: 'Accumulated USD cost of the turn.' }),
		turns: Type.Number({ description: 'Turns in the session file.' }),
	},
	{ additionalProperties: false },
);

const StructuredResultItemSchema = Type.Object(
	{
		label: Type.Optional(
			Type.String({
				maxLength: MAX_ID_LENGTH,
				description: 'Session label to pass to subagent_stats or reuseLabel.',
			}),
		),
		agent: Type.String({
			maxLength: MAX_ID_LENGTH,
			description: 'Agent name that ran the step.',
		}),
		agentSource: StructuredAgentSource,
		exitCode: Type.Number({ description: 'Child process exit code; 0 is success.' }),
		stopReason: Type.Optional(Type.String({ maxLength: MAX_STOP_REASON_LENGTH })),
		errorMessage: Type.Optional(
			Type.String({
				maxLength: MAX_ERROR_MESSAGE_LENGTH,
				description: 'Turn error message, capped to its declared maximum length.',
			}),
		),
		herdrStatus: Type.Optional(StructuredHerdrStatus),
		steered: Type.Optional(
			Type.Boolean({
				description: 'Whether budget enforcement steered the session to report-only mode.',
			}),
		),
		blockReason: Type.Optional(StructuredBlockReason),
		step: Type.Optional(Type.Number({ description: 'One-based position in a chain.' })),
		delegationId: Type.Optional(Type.String({ maxLength: MAX_ID_LENGTH })),
		taskId: Type.Optional(Type.String({ maxLength: MAX_ID_LENGTH })),
		usage: Type.Optional(StructuredUsageSchema),
	},
	{ additionalProperties: false },
);

export const SubagentStructuredResultSchema = Type.Object(
	{
		mode: StructuredMode,
		agentScope: StructuredAgentScope,
		results: Type.Array(StructuredResultItemSchema, {
			maxItems: MAX_STRUCTURED_RESULTS,
			description: 'One entry per completed delegation, capped at the declared maximum.',
		}),
		refusal: Type.Optional(
			Type.Object(
				{
					kind: StructuredRefusalKind,
					message: Type.String({
						maxLength: MAX_REFUSAL_MESSAGE_LENGTH,
						description: 'Model-facing refusal text, capped to its declared maximum length.',
					}),
				},
				{ additionalProperties: false },
			),
		),
		truncated: Type.Optional(
			Type.Boolean({ description: 'True when results were capped and later steps were dropped.' }),
		),
	},
	{ additionalProperties: false },
);
