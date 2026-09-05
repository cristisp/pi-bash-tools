import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROLE_BUDGETS } from './config.ts';
import type { RoleBudget } from './types.ts';

/** Name of the orchestration guide written next to the agent definition files. */
export const ORCHESTRATION_GUIDE_FILENAME = 'subagent_orchestration.md';

const TEMPLATE_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'orchestration-guide.md',
);

const ROLE_BUDGET_PLACEHOLDER = '{{role_budgets}}';

interface GuideRole {
	/** Agent name the budget is looked up under. */
	role: string;
	/** Role name as it reads in the guide. */
	label: string;
	/** Deliverable the output-token limit applies to. */
	artifact: string;
	/** Discipline note that the call counts alone do not express. */
	note?: (budget: RoleBudget) => string;
}

const GUIDE_ROLES: GuideRole[] = [
	{ role: 'scout', label: 'Scout', artifact: 'handoff' },
	{ role: 'planner', label: 'Planner', artifact: 'plan' },
	{
		role: 'worker',
		label: 'Worker',
		artifact: 'completion report',
		note: (budget) =>
			`Make at most ${budget.implementationDiscoveryCalls} discovery reads before the first implementation change, run at most ` +
			`${budget.fullValidationPasses} full validation passes, and mint one \`verify\` ref for the final state. ` +
			`That ref is the validation evidence unless the workflow carries a validator. ` +
			`When siblings implement in parallel, do not run the gate: the session that integrates the fan-in mints one ref for the combined state.`,
	},
	{
		role: 'validator',
		label: 'Validator',
		artifact: 'report',
		note: (budget) =>
			`Resolve the refs in the ledger before executing anything, up to ` +
			`${budget.fullValidationPasses} full validation passes; execute only what no live ref covers, and cite the ref you minted.`,
	},
	{
		role: 'reviewer',
		label: 'Reviewer',
		artifact: 'report',
		note: () => 'Review the supplied evidence instead of rediscovering it.',
	},
];

export interface OrchestrationGuideBudgets {
	/** Effective per-role budgets, normally the loaded config. */
	roleBudgets: Record<string, RoleBudget>;
	/** Extra tool and discovery calls granted per declared in-scope path. */
	scopeCallAllowancePerPath: number;
	/** Ceiling on the scope-derived allowance. */
	scopeCallAllowanceMax: number;
}

function count(value: number): string {
	return value.toLocaleString('en-US');
}

/**
 * Role budget bullets, generated from the budgets in effect so the guide cannot state limits the
 * extension does not enforce.
 */
export function roleBudgetLines(budgets: OrchestrationGuideBudgets): string {
	const lines = GUIDE_ROLES.map((entry) => {
		const budget = budgets.roleBudgets[entry.role] ?? DEFAULT_ROLE_BUDGETS[entry.role];
		if (!budget) return undefined;
		const calls = count(budget.toolCalls);
		const discovery = count(budget.discoveryCalls);
		const output = count(budget.outputTokens);
		const parts = [
			`- ${entry.label}: up to ${calls} tool calls, of which at most ${discovery} may be discovery reads, and a ${entry.artifact} of about ${output} output tokens.`,
		];
		if (entry.note) parts.push(`  ${entry.note(budget)}`);
		return parts.join('\n');
	}).filter((line): line is string => line !== undefined);
	const perPath = budgets.scopeCallAllowancePerPath;
	lines.push(
		`A delegation that declares in-scope paths is granted ${perPath} extra tool calls and ${perPath} extra ` +
			`discovery calls per declared path, and the added allowance is capped at ${count(
				budgets.scopeCallAllowanceMax,
			)} calls.`,
	);
	return lines.join('\n');
}

/** Path of the guide template shipped inside the package. */
export function orchestrationGuideTemplatePath(): string {
	return TEMPLATE_PATH;
}

/**
 * Render the orchestration guide for installation, with the role budgets of the given configuration.
 * @throws when the shipped template lost its budget placeholder.
 */
export function renderOrchestrationGuide(budgets: OrchestrationGuideBudgets): string {
	const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
	if (!template.includes(ROLE_BUDGET_PLACEHOLDER)) {
		throw new Error(
			`${TEMPLATE_PATH} is missing the ${ROLE_BUDGET_PLACEHOLDER} placeholder - the orchestration guide cannot state the budgets in effect`,
		);
	}
	return template.replace(ROLE_BUDGET_PLACEHOLDER, roleBudgetLines(budgets));
}
