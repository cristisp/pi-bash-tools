import * as path from 'node:path';
import { Type } from 'typebox';
import type { AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	type ToolAnnotations,
} from '@earendil-works/pi-coding-agent';
import { executeSubagent, SubagentOverrideParams, SubagentParams } from './execute.ts';
import { ORCHESTRATION_GUIDE_FILENAME } from './guide.ts';
import { closeSubagentFlow, sessionLinkedEntries } from './registry.ts';
import { REGISTRY_PATH } from './registry-store.ts';
import { renderSubagentCall, renderSubagentResult } from './render.ts';
import {
	SUBAGENT_CLOSE_LABEL_PARAM_DESCRIPTION,
	SUBAGENT_CLOSE_TOOL_DESCRIPTION,
	SUBAGENT_OVERRIDE_TOOL_DESCRIPTION,
	SUBAGENT_STATS_LABEL_PARAM_DESCRIPTION,
	SUBAGENT_STATS_TOOL_DESCRIPTION,
	subagentToolDescription,
} from './templates.ts';
import { sessionStatsText } from './session-stats.ts';
import { SubagentStructuredResultSchema, withStructuredContent } from './structured-result.ts';
import type { SubagentDetails } from './types.ts';

/**
 * S13-002: the four tools stay model-declared and programmatically reachable (codemode scripts and
 * `ctx.executeTool()`), but only while active, so a session that excludes a tool through `--tools`
 * or settings excludes it from programmatic callers too. `direct` is the runtime default; declaring
 * it here records the decision instead of inheriting it. No tool declares a `namespace`.
 */
const DIRECT_EXPOSURE = 'direct' as const;

/**
 * S13-002: advisory, MCP-style hints for permission extensions, which may use them to decide which
 * calls to confirm. They are unverified and no code path in this extension reads them: enforcement
 * stays with the spawn boundary, composition rules, role budgets, and the nested guard.
 */
const DELEGATION_ANNOTATIONS = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
} satisfies ToolAnnotations;

/** Read-only inspection of session state. */
const STATS_ANNOTATIONS = {
	readOnlyHint: true,
	idempotentHint: true,
} satisfies ToolAnnotations;

/** Closing sessions can abandon in-flight work, and closing an already closed session is a no-op. */
const CLOSE_ANNOTATIONS = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
} satisfies ToolAnnotations;

export function registerSubagentTool(pi: ExtensionAPI) {
	const agentsDir = path.join(getAgentDir(), 'agents');
	const definition = {
		name: 'subagent',
		label: 'Subagent',
		description: subagentToolDescription({
			registryPath: REGISTRY_PATH,
			agentsDir,
			guidePath: path.join(agentsDir, ORCHESTRATION_GUIDE_FILENAME),
			configDirName: CONFIG_DIR_NAME,
		}),
		parameters: SubagentParams,

		async execute(
			_toolCallId: string,
			params: SubagentParams,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<SubagentDetails>> {
			const { compositionPolicy: _ignoredPolicy, ...standardParams } = params as SubagentParams & {
				compositionPolicy?: unknown;
			};
			return withStructuredContent(await executeSubagent(standardParams, signal, onUpdate, ctx));
		},

		renderCall(args: SubagentParams, theme: Theme, _context: unknown) {
			return renderSubagentCall(args, theme);
		},

		renderResult(
			result: AgentToolResult<SubagentDetails>,
			{ expanded }: { expanded: boolean },
			theme: Theme,
			_context: unknown,
		) {
			return renderSubagentResult(result, expanded, theme);
		},

		// S13-002: kind metadata for model-facing selection and permission extensions.
		exposure: DIRECT_EXPOSURE,
		annotations: DELEGATION_ANNOTATIONS,

		// S13-001: declared so the runtime feeds structuredContent to programmatic callers such as
		// codemode scripts; refused calls are error results that still carry the projection.
		outputSchema: SubagentStructuredResultSchema,
	};
	pi.registerTool(definition);
}

export function registerSubagentOverrideTool(pi: ExtensionAPI) {
	const definition = {
		name: 'subagent_override',
		label: 'Subagent Policy Override',
		description: SUBAGENT_OVERRIDE_TOOL_DESCRIPTION,
		parameters: SubagentOverrideParams,

		async execute(
			_toolCallId: string,
			params: SubagentOverrideParams,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<SubagentDetails>> {
			return withStructuredContent(await executeSubagent(params, signal, onUpdate, ctx));
		},

		renderCall(args: SubagentOverrideParams, theme: Theme, _context: unknown) {
			return renderSubagentCall(args, theme);
		},

		renderResult(
			result: AgentToolResult<SubagentDetails>,
			{ expanded }: { expanded: boolean },
			theme: Theme,
			_context: unknown,
		) {
			return renderSubagentResult(result, expanded, theme);
		},

		// S13-002: same metadata as subagent; the override tool is the policy escape hatch.
		exposure: DIRECT_EXPOSURE,
		annotations: DELEGATION_ANNOTATIONS,

		// S13-001: same structured-output contract as subagent.
		outputSchema: SubagentStructuredResultSchema,
	};
	pi.registerTool(definition);
}

export function registerSubagentStatsTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: 'subagent_stats',
		label: 'Subagent Session Stats',
		description: SUBAGENT_STATS_TOOL_DESCRIPTION,
		parameters: Type.Object({
			label: Type.String({ description: SUBAGENT_STATS_LABEL_PARAM_DESCRIPTION }),
		}),
		exposure: DIRECT_EXPOSURE,
		annotations: STATS_ANNOTATIONS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
			if (!sessionFile) {
				return {
					content: [
						{
							type: 'text',
							text: 'Subagent session ownership is unavailable: the current Pi session has no session file, so session stats are unavailable.',
						},
					],
					details: {},
				};
			}
			return {
				content: [{ type: 'text', text: await sessionStatsText(params.label, sessionFile) }],
				details: {},
			};
		},
	});
}

export function registerSubagentCloseTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: 'subagent_close',
		label: 'Close Subagents',
		description: SUBAGENT_CLOSE_TOOL_DESCRIPTION,
		parameters: Type.Object({
			label: Type.Optional(Type.String({ description: SUBAGENT_CLOSE_LABEL_PARAM_DESCRIPTION })),
		}),
		exposure: DIRECT_EXPOSURE,
		annotations: CLOSE_ANNOTATIONS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
			const entries = sessionLinkedEntries(sessionFile);
			if (params.label) {
				const target = entries.find((e) => e.label === params.label);
				if (!target) {
					return {
						content: [
							{
								type: 'text',
								text: `No session-linked subagent labeled "${params.label}". Session-linked subagents: ${entries.map((e) => e.label).join(', ') || '(none)'}`,
							},
						],
						details: {},
					};
				}
				return closeSubagentFlow([target], ctx);
			}
			return closeSubagentFlow(entries, ctx);
		},
	});
}
