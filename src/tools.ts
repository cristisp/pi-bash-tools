import * as path from 'node:path';
import { Type } from 'typebox';
import type { AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
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
import type { SubagentDetails } from './types.ts';

export function registerSubagentTool(pi: ExtensionAPI) {
	const agentsDir = path.join(getAgentDir(), 'agents');
	pi.registerTool({
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
			return executeSubagent(standardParams, signal, onUpdate, ctx);
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
	});
}

export function registerSubagentOverrideTool(pi: ExtensionAPI) {
	pi.registerTool({
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
			return executeSubagent(params, signal, onUpdate, ctx);
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
	});
}

export function registerSubagentStatsTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: 'subagent_stats',
		label: 'Subagent Session Stats',
		description: SUBAGENT_STATS_TOOL_DESCRIPTION,
		parameters: Type.Object({
			label: Type.String({ description: SUBAGENT_STATS_LABEL_PARAM_DESCRIPTION }),
		}),
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
