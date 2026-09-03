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
import { executeSubagent, SubagentParams } from './execute.ts';
import { closeSubagentFlow, sessionLinkedEntries } from './registry.ts';
import { REGISTRY_PATH } from './registry-store.ts';
import { renderSubagentCall, renderSubagentResult } from './render.ts';
import { REUSE_WORKFLOW_GUIDANCE } from './templates.ts';
import { sessionStatsText } from './session-stats.ts';
import type { SubagentDetails } from './types.ts';

export function registerSubagentTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: 'subagent',
		label: 'Subagent',
		description: [
			'Delegate tasks to specialized subagents with isolated context.',
			'Each subagent runs as a live pi session in its own herdr tab, labeled <agent>-<n> (e.g. worker-1, reviewer-2); the numbering is persistent.',
			'Tabs stay open after finishing until closed manually; sessions can be reused (preserving context).',
			`Registry of all subagent sessions: ${REGISTRY_PATH} (read it to find reusable sessions and their session files).`,
			`Registry entries include ctx:<tokens> - the context size at the last completed turn; use it to decide between reuseLabel and a fresh session.`,
			REUSE_WORKFLOW_GUIDANCE,
			'Before reusing a session, call subagent_stats with the bare label from the active Pi session list (e.g. worker-1) to check its context size, turn count, prior tasks, and reuse history, and judge whether reuse is actually cheaper than a fresh session.',
			'Reusing a review/audit/verification session anchors it on its earlier findings - it will tend to re-check the issues it already found and miss newly introduced ones. For a fresh review of code that changed since the session last ran, prefer a new session, or explicitly instruct the reused session to re-examine from scratch.',
			'Labels are scoped per herdr workspace: each workspace has its own worker-1, worker-2, ... numbering and session files; visibility and reuse are scoped to the active Pi session.',
			'reuseLabel and subagent_stats accept the bare label shown by the active Pi session list (e.g. worker-1); qualified workspace:label values and sessions from other Pi sessions are not reusable from the current session.',
			'Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder), agents (list available agents).',
			'Before choosing an agent name, call subagent with agents: true to see the available agents (name, description, source); pick the exact name that fits the task - never invent or modify agent names, unknown names fail.',
			'A session becomes read-only once its result is delivered to the main agent; reuseLabel + task makes it interactive again for a new task.',
			"Steers typed into a running subagent's tab are folded into its final outcome and marked [steered] in the result.",
			'listSubagents: true lists sessions linked to the active Pi session in a compact form and shows the workspace identity plus the exact bare label to reuse; listLabel/listStatus filter that listing, and listVerbose adds pane, session-file, and last-result diagnostics.',
			`Default agent scope is "user" (from ${path.join(getAgentDir(), 'agents')}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(' '),
		parameters: SubagentParams,

		async execute(
			_toolCallId: string,
			params: SubagentParams,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<SubagentDetails>> {
			return executeSubagent(params, signal, onUpdate, ctx);
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

export function registerSubagentStatsTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: 'subagent_stats',
		label: 'Subagent Session Stats',
		description: [
			`${REUSE_WORKFLOW_GUIDANCE} This tool is the stats step and must run before reuse.`,
			'Reports compact reuse-relevant stats: context size, turns, input/output usage, cost, reuse count, recent task history, the last error or the path of the last role report, and only relevant warnings.',
			'Context size and turns come from the session file itself, so the report is current even while the session runs.',
			'Use this to judge cost and impact: a session with a large context, many turns, or many reuses is usually better replaced by a fresh session; a session whose task history does not match the new task topic is a poor reuse target.',
			'Review/audit/verification tasks carry a hidden cost when reused: the session anchors on its earlier findings and may only retest those, missing newly introduced issues. For independent reviews of code that changed, prefer a fresh session or explicitly instruct the reused session to re-examine from scratch.',
			'reuseLabel and this tool accept only the bare label from the active Pi session list; qualified workspace:label values and sessions from other Pi sessions are not reusable from the current session. Never infer or increment a label after a failed lookup; call listSubagents again.',
		].join(' '),
		parameters: Type.Object({
			label: Type.String({
				description:
					'Exact bare reuseLabel copied from an active-session entry after calling listSubagents; pass the same label to subagent_stats before reuse. Never infer or increment labels, use labels from another workspace, or pass workspace:label.',
			}),
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
		description: [
			'Close subagents linked to the current session: closes their herdr tabs and removes them from the registry (session files are preserved).',
			'May only be used when the user explicitly asks to close subagents - never autonomously.',
			'Without a label, closes all subagents linked to this session.',
			'With a label, closes only that session-linked subagent (e.g. to retire a broken session the user wants stopped).',
		].join(' '),
		parameters: Type.Object({
			label: Type.Optional(
				Type.String({
					description:
						'Label of a session-linked subagent to close (e.g. worker-1). Omit to close all session-linked subagents.',
				}),
			),
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
