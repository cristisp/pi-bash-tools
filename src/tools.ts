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
			'Labels are scoped per herdr workspace: each workspace has its own worker-1, worker-2, ... numbering and session files.',
			'Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).',
			'A session becomes read-only once its result is delivered to the main agent; reuseLabel + task makes it interactive again for a new task.',
			"Steers typed into a running subagent's tab are folded into its final outcome and marked [steered] in the result.",
			'listSubagents: true lists all sessions; listLabel/listStatus/listVerbose filter the listing (single entry, status, full last result).',
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
