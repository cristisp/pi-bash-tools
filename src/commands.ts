import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	DynamicBorder,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Container, type SelectItem, SelectList, Text } from '@earendil-works/pi-tui';
import { discoverAgents } from './agents.ts';
import { configPath, DEFAULT_CONFIG, getConfig } from './config.ts';
import { ORCHESTRATION_GUIDE_FILENAME, renderOrchestrationGuide } from './guide.ts';
import {
	hasThinkingLevel,
	isValidModelSpec,
	normalizeModelSpec,
	splitModelSpec,
} from './model-spec.ts';
import {
	PRESET_ENTRY_TYPE,
	type FindModel,
	effectivePresetName,
	findModelFrom,
	formatPresetSummary,
	readPresetOverride,
	unavailableModelsByPreset,
} from './presets.ts';
import { closeSubagentFlow, sessionLinkedEntries } from './registry.ts';
import { AGENT_TEMPLATES, renderAgentFile } from './templates.ts';

const REVERT_PRESET = '(use config default)';
const STATUS_KEY = 'subagent-preset';

function invalidModelMessage(value: string): string {
	return `Invalid model "${value}". Use provider/model:thinking_level with level off, minimal, low, medium, high, xhigh, or max - e.g. github-copilot/gpt-5.6-luna:high`;
}

function unavailableModelMessage(value: string): string {
	return `Model "${value}" is not available in pi - check /model or your provider setup and use an available provider/model`;
}

async function promptAgentModels(
	ctx: { ui: ExtensionContext['ui']; modelRegistry?: unknown },
	agents: { name: string; source: string }[],
	opts: { required: boolean; commandName: string },
): Promise<Record<string, string> | undefined> {
	const findModel: FindModel | undefined = findModelFrom(ctx.modelRegistry);
	const models: Record<string, string> = {};
	for (const agent of agents) {
		const suffix = opts.required ? '' : ' - empty to skip';
		let chosen: string | null = null;
		for (let attempt = 0; attempt < 3; attempt++) {
			const spec = await ctx.ui.input(
				`Model for ${agent.name}${agent.source === 'project' ? ' (project agent)' : ''} (provider/model:thinking_level)${suffix}`,
				'e.g. github-copilot/gpt-5.6-luna:high',
			);
			if (spec === undefined) {
				ctx.ui.notify(`${opts.commandName} canceled`, 'info');
				return undefined;
			}
			const trimmed = spec.trim();
			if (!trimmed && !opts.required) {
				chosen = '';
				break;
			}
			if (trimmed && isValidModelSpec(trimmed) && hasThinkingLevel(trimmed)) {
				const normalized = normalizeModelSpec(trimmed);
				const parts = splitModelSpec(normalized);
				if (!parts || !findModel || findModel(parts.provider, parts.modelId)) {
					chosen = normalized;
					break;
				}
				if (attempt < 2) ctx.ui.notify(unavailableModelMessage(normalized), 'warning');
				continue;
			}
			if (attempt < 2) ctx.ui.notify(invalidModelMessage(trimmed || '(empty)'), 'warning');
		}
		if (chosen === null) return undefined;
		if (chosen) models[agent.name] = chosen;
	}
	return models;
}

function readConfigRecord(configFile: string): Record<string, unknown> | null {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
		return raw as Record<string, unknown>;
	} catch {
		return null;
	}
}

function writeConfigRecord(configFile: string, record: Record<string, unknown>): void {
	fs.writeFileSync(configFile, `${JSON.stringify(record, null, 2)}\n`);
}

function presetEntriesOf(record: Record<string, unknown>): Record<string, unknown> {
	const presets = record.modelPresets;
	if (!presets || typeof presets !== 'object' || Array.isArray(presets)) return {};
	const clean: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(presets as Record<string, unknown>)) {
		if (name === '__proto__') continue;
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			clean[name] = value;
			continue;
		}
		const agentEntries: Record<string, unknown> = {};
		for (const [agentName, spec] of Object.entries(value as Record<string, unknown>)) {
			if (agentName === '__proto__') continue;
			agentEntries[agentName] = spec;
		}
		clean[name] = agentEntries;
	}
	return clean;
}

function configDefinesPresets(record: Record<string, unknown> | null): boolean {
	if (!record) return false;
	if (Object.keys(presetEntriesOf(record)).length > 0) return true;
	return typeof record.defaultPreset === 'string' && !!record.defaultPreset;
}

function seedDefaultPreset(record: Record<string, unknown>, models: Record<string, string>): void {
	record.modelPresets = { default: models };
	record.defaultPreset = 'default';
}

function updateDefaultPreset(
	record: Record<string, unknown>,
	models: Record<string, string>,
): void {
	const existing = presetEntriesOf(record);
	const currentDefault =
		existing.default && typeof existing.default === 'object' && !Array.isArray(existing.default)
			? (existing.default as Record<string, unknown>)
			: {};
	record.modelPresets = { ...existing, default: { ...currentDefault, ...models } };
}

function setPresetEntries(
	record: Record<string, unknown>,
	name: string,
	entries: Record<string, string>,
): void {
	record.modelPresets = { ...presetEntriesOf(record), [name]: entries };
}

export function registerSetupCommand(pi: ExtensionAPI) {
	pi.registerCommand('setup-subagents', {
		description:
			'Create or update the planner, reviewer, scout, worker, and validator agent files in ~/.pi/agent/agents, prompting for a model (provider/model:thinking_level) per agent; writes the models into the "default" subagent preset in the subagent-herdr config file (asks before overriding existing presets) and writes the orchestration guide next to the agent files',
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify('/setup-subagents needs an interactive session', 'warning');
				return;
			}
			const configFile = configPath();
			const existingRecord = fs.existsSync(configFile) ? readConfigRecord(configFile) : null;
			const overridesPresets = configDefinesPresets(existingRecord);
			let updatePresets = true;
			if (overridesPresets) {
				const presetNames = Object.keys(presetEntriesOf(existingRecord!)).join(', ');
				updatePresets = await ctx.ui.confirm(
					'Update the "default" preset?',
					`The config at ${configFile} already defines model presets${presetNames ? `: ${presetNames}` : ''}.\n\nUpdate its "default" preset with the models you enter next? Other presets and the defaultPreset setting are preserved.`,
				);
			}

			let models: Record<string, string> | undefined;
			if (updatePresets) {
				models = await promptAgentModels(
					ctx,
					AGENT_TEMPLATES.map((t) => ({ name: t.name, source: 'user' })),
					{ required: true, commandName: '/setup-subagents' },
				);
				if (!models) {
					ctx.ui.notify('/setup-subagents aborted: invalid model spec', 'error');
					return;
				}
			}

			const agentsDir = path.join(getAgentDir(), 'agents');
			const guideFile = path.join(agentsDir, ORCHESTRATION_GUIDE_FILENAME);
			const existing = [
				...AGENT_TEMPLATES.filter((t) => fs.existsSync(path.join(agentsDir, t.filename))).map(
					(t) => t.filename,
				),
				...(fs.existsSync(guideFile) ? [ORCHESTRATION_GUIDE_FILENAME] : []),
			];
			if (existing.length > 0) {
				const ok = await ctx.ui.confirm(
					'Overwrite existing agent files?',
					`These files already exist and would be overwritten:\n${existing.map((name) => `- ${name}`).join('\n')}\n\nContinue?`,
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
				fs.writeFileSync(file, renderAgentFile(t));
				if (existed) updated++;
				else created++;
			}
			let guideMessage: string;
			try {
				const rendered = renderOrchestrationGuide(getConfig());
				fs.writeFileSync(guideFile, rendered);
				guideMessage = `orchestration guide written to ${guideFile}`;
				const legacyGuide = path.join(path.dirname(agentsDir), 'SUBAGENTS_GUIDE.md');
				if (fs.existsSync(legacyGuide) && fs.readFileSync(legacyGuide, 'utf-8') !== rendered) {
					guideMessage += ` - ${legacyGuide} is hand-maintained guidance; point the system prompt at ${guideFile} and delete it`;
				}
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				guideMessage = `orchestration guide NOT written (${reason})`;
				ctx.ui.notify(guideMessage, 'warning');
			}

			let configMessage: string;
			if (!updatePresets) {
				configMessage = `Config file presets left unchanged at ${configFile}`;
			} else if (!fs.existsSync(configFile)) {
				writeConfigRecord(configFile, {
					...DEFAULT_CONFIG,
					modelPresets: { default: models! },
					defaultPreset: 'default',
				});
				configMessage = `Config file created at ${configFile} with default preset`;
			} else if (existingRecord === null) {
				configMessage = `Could not update ${configFile} (invalid JSON) - preset not written`;
			} else if (Object.keys(presetEntriesOf(existingRecord)).length > 0) {
				updateDefaultPreset(existingRecord, models!);
				writeConfigRecord(configFile, existingRecord);
				configMessage = `Config file "default" preset updated at ${configFile}`;
			} else {
				seedDefaultPreset(existingRecord, models!);
				writeConfigRecord(configFile, existingRecord);
				configMessage = `Config file seeded with default preset at ${configFile}`;
			}
			ctx.ui.notify(
				`Subagents ready - ${created} created, ${updated} updated. ${configMessage}. ${guideMessage}`,
				'info',
			);
			setPresetStatus(
				ctx,
				effectivePresetName(readPresetOverride(ctx.sessionManager), getConfig()),
			);
		},
	});
}

export function presetSelectItems(
	cfg: ReturnType<typeof getConfig>,
	current: string | undefined,
): SelectItem[] {
	const items: SelectItem[] = Object.keys(cfg.modelPresets).map((name) => ({
		value: name,
		label: `${name}${name === current ? ' (active)' : ''}${name === cfg.defaultPreset ? ' [default]' : ''}`,
		description: formatPresetSummary(cfg.modelPresets[name]),
	}));
	items.push({
		value: REVERT_PRESET,
		label: '(use config default)',
		description: cfg.defaultPreset
			? formatPresetSummary(cfg.modelPresets[cfg.defaultPreset])
			: 'no default preset - subagents run with the pi default model',
	});
	return items;
}

function setPresetStatus(ctx: ExtensionContext, presetName: string | undefined): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, presetName ? `subagent preset: ${presetName}` : undefined);
}

export function registerPresetStatus(pi: ExtensionAPI) {
	pi.on('session_start', async (_event, ctx) => {
		const cfg = getConfig();
		const findModel = findModelFrom(ctx.modelRegistry);
		if (ctx.hasUI) {
			const stale = unavailableModelsByPreset(cfg, findModel);
			const lines = Object.entries(stale).map(
				([name, entries]) => `- "${name}": ${formatPresetSummary(entries)}`,
			);
			if (lines.length > 0) {
				ctx.ui.notify(
					`Some subagent preset models are not available in pi:\n${lines.join('\n')}\nUpdate modelPresets in ${configPath()}`,
					'warning',
				);
			}
		}
		setPresetStatus(ctx, effectivePresetName(readPresetOverride(ctx.sessionManager), cfg));
	});
}

async function showPresetSelector(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cfg: ReturnType<typeof getConfig>,
): Promise<void> {
	const current = effectivePresetName(readPresetOverride(ctx.sessionManager), cfg);
	const items = presetSelectItems(cfg, current);
	const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg('accent', str)));
		container.addChild(new Text(theme.fg('accent', theme.bold('Select subagent model preset'))));
		container.addChild(
			new Text(
				theme.fg(
					'muted',
					`current: ${current ?? '(config default)'} | presets from ${configPath()}`,
				),
			),
		);
		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (text) => theme.fg('accent', text),
			selectedText: (text) => theme.fg('accent', text),
			description: (text) => theme.fg('muted', text),
			scrollInfo: (text) => theme.fg('dim', text),
			noMatch: (text) => theme.fg('warning', text),
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg('dim', '↑↓ navigate • enter select • esc cancel')));
		container.addChild(new DynamicBorder((str) => theme.fg('accent', str)));
		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
	if (!result) return;
	if (result === REVERT_PRESET) {
		pi.appendEntry(PRESET_ENTRY_TYPE, { preset: null });
		setPresetStatus(ctx, cfg.defaultPreset);
		ctx.ui.notify(
			cfg.defaultPreset
				? `Subagent preset cleared for this session - using config default "${cfg.defaultPreset}"`
				: 'Subagent preset cleared for this session - subagents run with the pi default model',
			'info',
		);
		return;
	}
	pi.appendEntry(PRESET_ENTRY_TYPE, { preset: result });
	setPresetStatus(ctx, result);
	ctx.ui.notify(`Subagent preset for this session: ${result}`, 'info');
}

export function registerSelectPresetCommand(pi: ExtensionAPI) {
	pi.registerCommand('select-subagent-preset', {
		description:
			'Select the subagent model preset for this session (presets configured as modelPresets in the subagent-herdr config file; without a selection the config defaultPreset applies)',
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify('/select-subagent-preset needs an interactive session', 'warning');
				return;
			}
			const cfg = getConfig();
			if (Object.keys(cfg.modelPresets).length === 0) {
				ctx.ui.notify(
					`No subagent model presets configured. Add a "modelPresets" object (agent name -> provider/model(:thinking_level)) and an optional "defaultPreset" to ${configPath()}, or create one with /create-subagent-preset`,
					'warning',
				);
				return;
			}
			await showPresetSelector(pi, ctx, cfg);
		},
	});
}

export function registerCreatePresetCommand(pi: ExtensionAPI) {
	pi.registerCommand('create-subagent-preset', {
		description:
			'Create a subagent model preset: prompts for a name, then a model (provider/model:thinking_level) for each discovered agent - empty input skips an agent; the preset is not set as default (use defaultPreset in the config file or /select-subagent-preset per session)',
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify('/create-subagent-preset needs an interactive session', 'warning');
				return;
			}
			const cfg = getConfig();
			const scope = cfg.defaultAgentScope;
			const { agents, projectAgentsDir } = discoverAgents(ctx.cwd, scope);
			if (agents.length === 0) {
				ctx.ui.notify(
					`No agents found for agentScope "${scope}" (looked in ${path.join(getAgentDir(), 'agents')}${projectAgentsDir ? ` and ${projectAgentsDir}` : ''}) - create agent files first`,
					'warning',
				);
				return;
			}

			let name = '';
			for (let attempt = 0; attempt < 3; attempt++) {
				const raw = await ctx.ui.input('Preset name', 'e.g. cheap');
				if (raw === undefined) {
					ctx.ui.notify('/create-subagent-preset canceled', 'info');
					return;
				}
				name = raw.trim();
				if (name) break;
				if (attempt < 2) ctx.ui.notify('Preset name cannot be empty', 'warning');
			}
			if (!name) {
				ctx.ui.notify('/create-subagent-preset aborted: no preset name', 'error');
				return;
			}
			if (name === '__proto__') {
				ctx.ui.notify(
					'/create-subagent-preset aborted: "__proto__" is a reserved preset name',
					'error',
				);
				return;
			}
			if (Object.hasOwn(cfg.modelPresets, name)) {
				const ok = await ctx.ui.confirm(
					'Overwrite preset?',
					`A preset named "${name}" already exists with:\n${formatPresetSummary(cfg.modelPresets[name])}\n\nOverwrite its entries?`,
				);
				if (!ok) {
					ctx.ui.notify('/create-subagent-preset canceled - existing preset kept', 'info');
					return;
				}
			}

			const models = await promptAgentModels(ctx, agents, {
				required: false,
				commandName: '/create-subagent-preset',
			});
			if (!models) {
				ctx.ui.notify('/create-subagent-preset aborted: invalid model spec', 'error');
				return;
			}
			if (Object.keys(models).length === 0) {
				ctx.ui.notify(
					'/create-subagent-preset aborted: no models entered - preset not created',
					'warning',
				);
				return;
			}

			const configFile = configPath();
			if (!fs.existsSync(configFile)) {
				writeConfigRecord(configFile, { ...DEFAULT_CONFIG, modelPresets: { [name]: models } });
			} else {
				const record = readConfigRecord(configFile);
				if (!record) {
					ctx.ui.notify(
						`Could not update ${configFile} (invalid JSON) - preset not written`,
						'error',
					);
					return;
				}
				setPresetEntries(record, name, models);
				writeConfigRecord(configFile, record);
			}
			ctx.ui.notify(
				`Preset "${name}" created ${formatPresetSummary(models)} - select it with /select-subagent-preset`,
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
