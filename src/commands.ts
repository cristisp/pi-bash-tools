import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { configPath, DEFAULT_CONFIG } from './config.ts';
import { closeSubagentFlow, sessionLinkedEntries } from './registry.ts';
import {
	AGENT_TEMPLATES,
	isValidModelSpec,
	normalizeModelSpec,
	renderAgentFile,
} from './templates.ts';

async function promptForModel(ctx: { ui: ExtensionContext['ui'] }): Promise<string | undefined> {
	let model: string | undefined;
	for (let attempt = 0; attempt < 3; attempt++) {
		model = await ctx.ui.input(
			'Model for the five subagents (provider/model(:thinking_level), e.g. github-copilot/gpt-5.6-luna:high or cortecs/deepseek-v4-flash-0731)',
			'e.g. github-copilot/gpt-5.6-luna:high or cortecs/deepseek-v4-flash-0731',
		);
		if (model === undefined) {
			ctx.ui.notify('/setup-subagents canceled', 'info');
			return undefined;
		}
		model = model.trim();
		if (model && isValidModelSpec(model)) {
			return normalizeModelSpec(model);
		}
		if (attempt < 2) {
			ctx.ui.notify(
				`Invalid model "${model}". Use provider/model(:thinking_level) with level off, minimal, low, medium, high, xhigh, or max - e.g. github-copilot/gpt-5.6-luna:high`,
				'warning',
			);
		}
	}
	return undefined;
}

export function registerSetupCommand(pi: ExtensionAPI) {
	pi.registerCommand('setup-subagents', {
		description:
			'Create or update the planner, reviewer, scout, worker, and validator agent files in ~/.pi/agent/agents with a chosen model (provider/model(:thinking_level), e.g. github-copilot/gpt-5.6-luna:high), and create the subagent-herdr config file if missing',
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify('/setup-subagents needs an interactive session', 'warning');
				return;
			}
			const model = await promptForModel(ctx);
			if (!model) {
				ctx.ui.notify('/setup-subagents aborted: invalid model spec', 'error');
				return;
			}
			const agentsDir = path.join(getAgentDir(), 'agents');
			const existing = AGENT_TEMPLATES.filter((t) =>
				fs.existsSync(path.join(agentsDir, t.filename)),
			);
			if (existing.length > 0) {
				const ok = await ctx.ui.confirm(
					'Overwrite existing agent files?',
					`These files already exist and would be overwritten:\n${existing.map((t) => `- ${t.filename}`).join('\n')}\n\nContinue with model: ${model}`,
				);
				if (!ok) {
					ctx.ui.notify('/setup-subagents canceled - no files changed', 'info');
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
				`Subagents ready - ${created} created, ${updated} updated with model ${model}. Config file ${configCreated ? 'created' : 'already exists (left unchanged)'} at ${configFile}`,
				'info',
			);
		},
	});
}

export function registerKillCommand(pi: ExtensionAPI) {
	pi.registerCommand('kill-session-subagents', {
		description:
			'Close all subagents linked to this session: closes their herdr tabs and removes them from the registry (session files preserved)',
		handler: async (_args, ctx) => {
			const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
			const entries = sessionLinkedEntries(sessionFile);
			const result = await closeSubagentFlow(entries, ctx);
			const first = result.content[0];
			if (first && first.type === 'text') {
				ctx.ui.notify(first.text, 'info');
			}
		},
	});
}
