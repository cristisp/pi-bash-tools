import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { executeSubagent, SubagentParams } from "./execute.ts";
import { configPath, DEFAULT_CONFIG } from "./config.ts";
import { HERDR_ENV, HERDR_PANE_ID, HERDR_SOCKET_PATH, NESTED, getAgentStatus } from "./herdr.ts";
import { closeSubagentFlow, readRegistry, reconcileRegistry, REGISTRY_PATH, sessionLinkedEntries } from "./registry.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import { AGENT_TEMPLATES, isValidModelSpec, normalizeModelSpec, renderAgentFile } from "./templates.ts";
import type { SubagentDetails } from "./types.ts";

export default function (pi: ExtensionAPI) {
	if (!HERDR_ENV || !HERDR_SOCKET_PATH || !HERDR_PANE_ID) return;
	if (!NESTED) {
		reconcileRegistry().catch(() => {});
		pi.on("session_start", () => {
			reconcileRegistry().catch(() => {});
		});
	}

	registerSubagentTool(pi);
	if (!NESTED) {
		registerSubagentCloseTool(pi);
		registerSetupCommand(pi);
		registerKillCommand(pi);
	}
	registerInputHandler(pi);
}

function registerSubagentTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Each subagent runs as a live pi session in its own herdr tab, labeled <agent>-<n> (e.g. worker-1, reviewer-2); the numbering is persistent.",
			"Tabs stay open after finishing until closed manually; sessions can be reused (preserving context).",
			`Registry of all subagent sessions: ${REGISTRY_PATH} (read it to find reusable sessions and their session files).`,
			`Registry entries include ctx:<tokens> - the context size at the last completed turn; use it to decide between reuseLabel and a fresh session.`,
			"Labels are scoped per herdr workspace: each workspace has its own worker-1, worker-2, ... numbering and session files.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"A session becomes read-only once its result is delivered to the main agent; reuseLabel + task makes it interactive again for a new task.",
			"Steers typed into a running subagent's tab are folded into its final outcome and marked [steered] in the result.",
			"listSubagents: true lists all sessions; listLabel/listStatus/listVerbose filter the listing (single entry, status, full last result).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
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

function registerSubagentCloseTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent_close",
		label: "Close Subagents",
		description: [
			"Close subagents linked to the current session: closes their herdr tabs and removes them from the registry (session files are preserved).",
			"May only be used when the user explicitly asks to close subagents - never autonomously.",
			"Without a label, closes all subagents linked to this session.",
			"With a label, closes only that session-linked subagent (e.g. to retire a broken session the user wants stopped).",
		].join(" "),
		parameters: Type.Object({
			label: Type.Optional(
				Type.String({ description: "Label of a session-linked subagent to close (e.g. worker-1). Omit to close all session-linked subagents." }),
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
								type: "text",
								text: `No session-linked subagent labeled "${params.label}". Session-linked subagents: ${entries.map((e) => e.label).join(", ") || "(none)"}`,
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

async function promptForModel(ctx: { ui: ExtensionContext["ui"] }): Promise<string | undefined> {
	let model: string | undefined;
	for (let attempt = 0; attempt < 3; attempt++) {
		model = await ctx.ui.input(
			"Model for the four subagents (provider/model(:thinking_level), e.g. github-copilot/gpt-5.6-luna:high or cortecs/deepseek-v4-flash-0731)",
			"e.g. github-copilot/gpt-5.6-luna:high or cortecs/deepseek-v4-flash-0731",
		);
		if (model === undefined) {
			ctx.ui.notify("/setup-subagents canceled", "info");
			return undefined;
		}
		model = model.trim();
		if (model && isValidModelSpec(model)) {
			return normalizeModelSpec(model);
		}
		if (attempt < 2) {
			ctx.ui.notify(
				`Invalid model "${model}". Use provider/model(:thinking_level) with level off, minimal, low, medium, high, xhigh, or max - e.g. github-copilot/gpt-5.6-luna:high`,
				"warning",
			);
		}
	}
	return undefined;
}

function registerSetupCommand(pi: ExtensionAPI) {
	pi.registerCommand("setup-subagents", {
		description:
			"Create or update the planner, reviewer, scout, and worker agent files in ~/.pi/agent/agents with a chosen model (provider/model(:thinking_level), e.g. github-copilot/gpt-5.6-luna:high), and create the subagent-herdr config file if missing",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/setup-subagents needs an interactive session", "warning");
				return;
			}
			const model = await promptForModel(ctx);
			if (!model) {
				ctx.ui.notify("/setup-subagents aborted: invalid model spec", "error");
				return;
			}
			const agentsDir = path.join(getAgentDir(), "agents");
			const existing = AGENT_TEMPLATES.filter((t) => fs.existsSync(path.join(agentsDir, t.filename)));
			if (existing.length > 0) {
				const ok = await ctx.ui.confirm(
					"Overwrite existing agent files?",
					`These files already exist and would be overwritten:\n${existing.map((t) => `- ${t.filename}`).join("\n")}\n\nContinue with model: ${model}`,
				);
				if (!ok) {
					ctx.ui.notify("/setup-subagents canceled - no files changed", "info");
					return;
				}
			}
			fs.mkdirSync(agentsDir, { recursive: true });
			let created = 0;
			let updated = 0;
			for (const t of AGENT_TEMPLATES) {
				const file = path.join(agentsDir, t.filename);
				const existed = fs.existsSync(file);
				fs.writeFileSync(file, renderAgentFile(t, model));
				if (existed) updated++;
				else created++;
			}
			const configFile = configPath();
			const configCreated = !fs.existsSync(configFile);
			if (configCreated) {
				fs.writeFileSync(configFile, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
			}
			ctx.ui.notify(
				`Subagents ready - ${created} created, ${updated} updated with model ${model}. Config file ${configCreated ? "created" : "already exists (left unchanged)"} at ${configFile}`,
				"info",
			);
		},
	});
}

function registerKillCommand(pi: ExtensionAPI) {
	pi.registerCommand("kill-session-subagents", {
		description: "Close all subagents linked to this session: closes their herdr tabs and removes them from the registry (session files preserved)",
		handler: async (_args, ctx) => {
			const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
			const entries = sessionLinkedEntries(sessionFile);
			const result = await closeSubagentFlow(entries, ctx);
			const first = result.content[0];
			if (first && first.type === "text") {
				ctx.ui.notify(first.text, "info");
			}
		},
	});
}

function registerInputHandler(pi: ExtensionAPI) {
	pi.on("input", async (event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;
		const reg = readRegistry();
		for (const entry of Object.values(reg.tabs)) {
			if (entry.sessionFile !== sessionFile || entry.status === "running") continue;
			const { status } = await getAgentStatus(entry.paneId);
			if (status === "working" || status === "blocked") {
				return { action: "continue" };
			}
			ctx.ui.notify(
				`Subagent session ${entry.label} is read-only (its result was delivered). Reuse it via the subagent tool to make it interactive again.`,
				"warning",
			);
			return { action: "handled" };
		}
		return { action: "continue" };
	});
}
