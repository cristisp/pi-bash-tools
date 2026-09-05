import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { DEFAULT_ROLE_BUDGETS } from '../src/config.ts';
import { SubagentParams } from '../src/execute.ts';
import { REGISTRY_PATH } from '../src/registry-store.ts';
import {
	REUSE_WORKFLOW_GUIDANCE,
	SUBAGENT_CLOSE_LABEL_PARAM_DESCRIPTION,
	SUBAGENT_CLOSE_TOOL_DESCRIPTION,
	SUBAGENT_STATS_LABEL_PARAM_DESCRIPTION,
	SUBAGENT_STATS_TOOL_DESCRIPTION,
	subagentToolDescription,
} from '../src/templates.ts';
import {
	registerSubagentCloseTool,
	registerSubagentStatsTool,
	registerSubagentTool,
} from '../src/tools.ts';

/**
 * Coverage for the registration surface of src/tools.ts. The tools registered here are the only
 * contract a main agent sees, and the description text is what a child agent is steered by, so the
 * assertions below are about behaviour (which tool exists, what the schema accepts, which rules the
 * child is actually told) rather than about incidental wording.
 */

interface RegisteredTool {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: unknown;
	renderCall?: unknown;
	renderResult?: unknown;
}

/** Minimal ExtensionAPI stand-in: registration is the only thing these tests exercise. */
function registerAllTools(): RegisteredTool[] {
	const registered: RegisteredTool[] = [];
	const pi = {
		registerTool: (tool: RegisteredTool) => {
			registered.push(tool);
		},
	} as unknown as ExtensionAPI;
	registerSubagentTool(pi);
	registerSubagentStatsTool(pi);
	registerSubagentCloseTool(pi);
	return registered;
}

function toolByName(name: string): RegisteredTool {
	const tool = registerAllTools().find((t) => t.name === name);
	if (!tool) throw new Error(`tool "${name}" was not registered`);
	return tool;
}

/** Plain JSON Schema node, with TypeBox metadata symbols stripped so the shape can be inspected. */
interface SchemaNode {
	type?: string;
	enum?: unknown[];
	anyOf?: SchemaNode[];
	oneOf?: SchemaNode[];
	const?: unknown;
	default?: unknown;
	description?: string;
	minimum?: number;
	maximum?: number;
	items?: SchemaNode;
	required?: string[];
	properties?: Record<string, SchemaNode>;
}

function jsonSchema(schema: unknown): SchemaNode {
	return JSON.parse(JSON.stringify(schema));
}

function properties(schema: unknown): Record<string, SchemaNode> {
	return jsonSchema(schema).properties ?? {};
}

function requiredFields(schema: unknown): string[] {
	return jsonSchema(schema).required ?? [];
}

/**
 * Enum values for both TypeBox encodings: a single `enum`, or a union of literals (`anyOf`), which is
 * how the string unions in the subagent schema are expressed.
 */
function enumValues(node: SchemaNode | undefined): unknown[] | undefined {
	if (!node) return undefined;
	if (Array.isArray(node.enum)) return node.enum;
	const members = node.anyOf ?? node.oneOf;
	if (Array.isArray(members)) {
		const values = members.flatMap((m) => {
			if (Array.isArray(m.enum)) return m.enum;
			return 'const' in m ? [m.const] : [];
		});
		return values.length === members.length ? values : undefined;
	}
	return undefined;
}

/**
 * Numbers written out in prose. Excludes numbers that are part of an identifier-ish token
 * (labels such as `worker-1`, paths, `v1.2.3`) because those are names, not budget figures.
 */
function numericLiterals(text: string): string[] {
	return text.match(/(?<![\w/-])\d+(?:\.\d+)*(?![\w/-])/g) ?? [];
}

/** Configured budget figures: every number a user can set through the budgets config block. */
function configuredBudgetValues(): Set<string> {
	const values = new Set<string>();
	for (const budget of Object.values(DEFAULT_ROLE_BUDGETS)) {
		for (const value of Object.values(budget)) {
			if (typeof value === 'number') values.add(String(value));
		}
	}
	return values;
}

const DYNAMIC_VALUES = {
	registryPath: REGISTRY_PATH,
	agentsDir: path.join(getAgentDir(), 'agents'),
	configDirName: CONFIG_DIR_NAME,
};

/**
 * The description text src/tools.ts authors, with the interpolated runtime values removed so a
 * number that happens to live in a path is not mistaken for hand-typed prose.
 */
function authoredToolProse(): string {
	const tool = toolByName('subagent');
	const stats = toolByName('subagent_stats');
	const close = toolByName('subagent_close');
	const statsParams = properties(stats.parameters);
	const closeParams = properties(close.parameters);
	const corpus = [
		tool.description,
		stats.description,
		close.description,
		statsParams.label?.description,
		closeParams.label?.description,
	]
		.filter((part): part is string => typeof part === 'string')
		.join(' ');
	let text = corpus;
	for (const value of Object.values(DYNAMIC_VALUES)) text = text.split(value).join(' ');
	return text;
}

describe('subagent tool registration', () => {
	it('registers the three tool names in order with their labels', () => {
		expect(registerAllTools().map((t) => t.name)).toEqual([
			'subagent',
			'subagent_stats',
			'subagent_close',
		]);
		expect(registerAllTools().map((t) => t.label)).toEqual([
			'Subagent',
			'Subagent Session Stats',
			'Close Subagents',
		]);
	});

	it('gives every registered tool an executable handler and renders the subagent tool', () => {
		for (const tool of registerAllTools()) expect(typeof tool.execute).toBe('function');
		const subagent = toolByName('subagent');
		expect(typeof subagent.renderCall).toBe('function');
		expect(typeof subagent.renderResult).toBe('function');
	});

	it('registers the exported SubagentParams schema object itself for subagent', () => {
		expect(toolByName('subagent').parameters).toBe(SubagentParams);
	});
});

describe('subagent parameter schema', () => {
	const schema = () => jsonSchema(toolByName('subagent').parameters);
	const props = () => properties(toolByName('subagent').parameters);

	it('accepts an object whose top-level keys are all optional', () => {
		expect(schema().type).toBe('object');
		// No key is required: single/parallel/chain/list/agents/reuse modes are resolved from the keys
		// that are present, so requiring any of them would reject valid calls.
		const optionalKeys = [
			'acceptanceCriteria',
			'agent',
			'agentScope',
			'agents',
			'chain',
			'confirmProjectAgents',
			'cwd',
			'evidenceScope',
			'listLabel',
			'listStatus',
			'listSubagents',
			'listVerbose',
			'reuseLabel',
			'reviewMode',
			'scope',
			'task',
			'tasks',
			'tier',
			'taskId',
			'workflowMode',
		];
		expect(Object.keys(props()).toSorted()).toEqual(optionalKeys.toSorted());
		expect(requiredFields(toolByName('subagent').parameters)).toEqual([]);
	});

	it('types the mode-carrying parameters', () => {
		expect(props().agent.type).toBe('string');
		expect(props().task.type).toBe('string');
		expect(props().cwd.type).toBe('string');
		expect(props().taskId.type).toBe('string');
		expect(props().tasks.type).toBe('array');
		expect(props().chain.type).toBe('array');
		expect(props().acceptanceCriteria.type).toBe('array');
		expect(props().acceptanceCriteria.items?.type).toBe('string');
		expect(props().listSubagents.type).toBe('boolean');
		expect(props().agents.type).toBe('boolean');
		expect(props().listVerbose.type).toBe('boolean');
		expect(props().listLabel.type).toBe('string');
		expect(props().listStatus.type).toBe('string');
		expect(props().confirmProjectAgents.type).toBe('boolean');
	});

	it('requires agent and task on every parallel and chain entry', () => {
		for (const key of ['tasks', 'chain']) {
			const item = props()[key].items;
			if (!item) throw new Error(`${key} has no item schema`);
			expect(item.type).toBe('object');
			expect(Object.keys(item.properties ?? {}).toSorted()).toEqual([
				'agent',
				'cwd',
				'scope',
				'task',
			]);
			expect((item.required ?? []).toSorted()).toEqual(['agent', 'task']);
		}
	});

	it('pins the string unions and their documented defaults', () => {
		expect(enumValues(props().agentScope)).toEqual(['user', 'project', 'both']);
		expect(props().agentScope.default).toBe('user');
		expect(enumValues(props().evidenceScope)).toEqual(['session', 'flow']);
		expect(enumValues(props().workflowMode)).toEqual(['initial', 'remediation']);
		expect(enumValues(props().reviewMode)).toEqual([
			'primary',
			'security',
			'validation',
			'remediation',
		]);
		expect(props().confirmProjectAgents.default).toBe(true);
	});

	it('bounds the recorded tier to the orchestration tier range', () => {
		expect(props().tier.type).toBe('integer');
		expect(props().tier.minimum).toBe(0);
		expect(props().tier.maximum).toBe(4);
	});
});

describe('subagent_stats and subagent_close parameter schemas', () => {
	it('requires the bare label for stats so a lookup is never guessed', () => {
		const stats = toolByName('subagent_stats');
		expect(jsonSchema(stats.parameters).type).toBe('object');
		expect(Object.keys(properties(stats.parameters))).toEqual(['label']);
		expect(requiredFields(stats.parameters)).toEqual(['label']);
		expect(properties(stats.parameters).label.type).toBe('string');
	});

	it('makes the label optional for close so it can retire every linked session', () => {
		const close = toolByName('subagent_close');
		expect(Object.keys(properties(close.parameters))).toEqual(['label']);
		expect(requiredFields(close.parameters)).toEqual([]);
		expect(properties(close.parameters).label.type).toBe('string');
	});
});

describe('registered description text is composed, not paraphrased', () => {
	it('composes the subagent description from the shared templates source', () => {
		expect(toolByName('subagent').description).toBe(subagentToolDescription(DYNAMIC_VALUES));
		expect(toolByName('subagent_stats').description).toBe(SUBAGENT_STATS_TOOL_DESCRIPTION);
		expect(toolByName('subagent_close').description).toBe(SUBAGENT_CLOSE_TOOL_DESCRIPTION);
		expect(properties(toolByName('subagent_stats').parameters).label.description).toBe(
			SUBAGENT_STATS_LABEL_PARAM_DESCRIPTION,
		);
		expect(properties(toolByName('subagent_close').parameters).label.description).toBe(
			SUBAGENT_CLOSE_LABEL_PARAM_DESCRIPTION,
		);
	});

	it('embeds the shared reuse guidance verbatim in the subagent description', () => {
		const description = toolByName('subagent').description;
		// A contiguous copy, not a paraphrase: the child must be steered by the same rules as the
		// agent templates, and a paraphrase drifts silently.
		expect(description).toContain(REUSE_WORKFLOW_GUIDANCE);
		for (const sentence of REUSE_WORKFLOW_GUIDANCE.split(/(?<=\.)\s+/)) {
			expect(description).toContain(sentence);
		}
		// Embedded once, so the rules are not stated twice in different words.
		expect(description.split(REUSE_WORKFLOW_GUIDANCE)).toHaveLength(2);
	});

	it('carries the reuse guidance into the parameters a caller picks before reuse', () => {
		const props = properties(toolByName('subagent').parameters);
		expect(props.reuseLabel.description).toContain(REUSE_WORKFLOW_GUIDANCE);
		expect(props.listSubagents.description).toContain(REUSE_WORKFLOW_GUIDANCE);
	});

	it('tells the child how to reuse a session and how to judge reuse', () => {
		const description = toolByName('subagent').description;
		// Label discovery, stats-before-reuse, and the fresh-vs-reuse judgement.
		expect(description).toContain(
			'Tabs stay open after finishing until closed manually; sessions can be reused (preserving context).',
		);
		expect(description).toContain(
			'Registry entries include ctx:<tokens> - the context size at the last completed turn; use it to decide between reuseLabel and a fresh session.',
		);
		expect(description).toContain(
			'Before reusing a session, call subagent_stats with the bare label from the active Pi session list (e.g. worker-1) to check its context size, turn count, prior tasks, and reuse history, and judge whether reuse is actually cheaper than a fresh session.',
		);
		expect(description).toContain(
			'Reusing a review/audit/verification session anchors it on its earlier findings - it will tend to re-check the issues it already found and miss newly introduced ones. For a fresh review of code that changed since the session last ran, prefer a new session, or explicitly instruct the reused session to re-examine from scratch.',
		);
	});

	it('states the label and workspace scoping rules the reuse path depends on', () => {
		const description = toolByName('subagent').description;
		expect(description).toContain(
			'Labels are scoped per herdr workspace: each workspace has its own worker-1, worker-2, ... numbering and session files; visibility and reuse are scoped to the active Pi session.',
		);
		expect(description).toContain(
			'reuseLabel and subagent_stats accept the bare label shown by the active Pi session list (e.g. worker-1); qualified workspace:label values and sessions from other Pi sessions are not reusable from the current session.',
		);
	});

	it('states the modes, the listing surface, the read-only transition and steering folding', () => {
		const description = toolByName('subagent').description;
		expect(description).toContain(
			'Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder), agents (list available agents).',
		);
		expect(description).toContain(
			'Before choosing an agent name, call subagent with agents: true to see the available agents (name, description, source); pick the exact name that fits the task - never invent or modify agent names, unknown names fail.',
		);
		expect(description).toContain(
			'A session becomes read-only once its result is delivered to the main agent; reuseLabel + task makes it interactive again for a new task.',
		);
		expect(description).toContain(
			"Steers typed into a running subagent's tab are folded into its final outcome and marked [steered] in the result.",
		);
		expect(description).toContain(
			'listSubagents: true lists sessions linked to the active Pi session in a compact form and shows the workspace identity plus the exact bare label to reuse; listLabel/listStatus filter that listing, and listVerbose adds pane, session-file, and last-result diagnostics.',
		);
	});

	it('interpolates the registry path and agent directories instead of hardcoding them', () => {
		const description = toolByName('subagent').description;
		expect(description).toContain(
			`Registry of all subagent sessions: ${REGISTRY_PATH} (read it to find reusable sessions and their session files).`,
		);
		expect(description).toContain(
			`Default agent scope is "user" (from ${DYNAMIC_VALUES.agentsDir}).`,
		);
		expect(description).toContain(
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		);
	});

	it('states the rules for the stats and close tools', () => {
		expect(toolByName('subagent_stats').description).toContain(
			'This tool is the stats step and must run before reuse.',
		);
		expect(toolByName('subagent_stats').description).toContain(
			'Use this to judge cost and impact: a session with a large context, many turns, or many reuses is usually better replaced by a fresh session; a session whose task history does not match the new task topic is a poor reuse target.',
		);
		expect(toolByName('subagent_stats').description).toContain(
			'reuseLabel and this tool accept only the bare label from the active Pi session list; qualified workspace:label values and sessions from other Pi sessions are not reusable from the current session. Never infer or increment a label after a failed lookup; call listSubagents again.',
		);
		expect(toolByName('subagent_close').description).toContain(
			'Close subagents linked to the current session: closes their herdr tabs and removes them from the registry (session files are preserved).',
		);
		expect(toolByName('subagent_close').description).toContain(
			'May only be used when the user explicitly asks to close subagents - never autonomously.',
		);
	});

	it('keeps hand-authored tool prose free of literal budget figures', () => {
		const prose = authoredToolProse();
		// Budget figures are configured per role (config.ts DEFAULT_ROLE_BUDGETS) and interpolated
		// where a child needs them, so no configurable number may be a literal in tool text.
		expect(numericLiterals(prose).filter((n) => configuredBudgetValues().has(n))).toEqual([]);
		// Stricter form: today the composed tool prose carries no standalone number at all, so a
		// newly hand-typed figure is caught whether or not it matches a current default.
		expect(numericLiterals(prose)).toEqual([]);
	});

	it('detects a budget figure when one is hand-typed into tool text', () => {
		// Positive control for the guard above: without it the assertion would pass vacuously.
		const budget = DEFAULT_ROLE_BUDGETS.worker.toolCalls;
		const handTyped = `The worker budget is ${budget} tool calls.`;
		expect(numericLiterals(handTyped)).toEqual([String(budget)]);
		expect(numericLiterals(handTyped).filter((n) => configuredBudgetValues().has(n))).toEqual([
			String(budget),
		]);
	});
});

describe('description prose lives in one source', () => {
	const source = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8');
	const templatesSource = readFileSync(new URL('../src/templates.ts', import.meta.url), 'utf8');

	/** Sentences the child reads, taken from the registered tools. */
	const sentences = () => {
		const dynamic = Object.values(DYNAMIC_VALUES);
		return (
			registerAllTools()
				.flatMap((tool) => tool.description.split(/(?<=\.)\s+/))
				.map((sentence) => sentence.trim())
				.filter((sentence) => sentence.length > 40)
				// Sentences carrying an interpolated runtime value are asserted in their composed form
				// above; here the interest is the static prose.
				.filter((sentence) => !dynamic.some((value) => sentence.includes(value)))
		);
	};

	it('composes the descriptions from the templates source instead of restating them', () => {
		expect(source).toMatch(/from '\.\/templates\.ts'/);
		// Every sentence a child reads lives in src/templates.ts, not in the registration site, so a
		// description change has one place to happen and one test that notices it.
		for (const sentence of sentences()) expect(templatesSource).toContain(sentence);
	});

	it('leaves no sentence of child-facing prose authored in src/tools.ts', () => {
		for (const sentence of sentences()) expect(source).not.toContain(sentence);
	});
});
