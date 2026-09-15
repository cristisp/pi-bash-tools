import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STALE_REF_RULE } from '../src/templates.ts';
import { isExclusiveWriteCommandId, verifySetsScriptOverrides } from '../src/budget.ts';
import { DEFAULT_CONFIG, DEFAULT_ROLE_BUDGETS, roleBudgetFor } from '../src/config.ts';
import {
	ORCHESTRATION_GUIDE_FILENAME,
	orchestrationGuideTemplatePath,
	compositionPolicyLines,
	renderOrchestrationGuide,
	roleBudgetLines,
} from '../src/guide.ts';
import type { RoleBudget } from '../src/types.ts';

const BUDGETS = {
	roleBudgets: DEFAULT_ROLE_BUDGETS,
	scopeCallAllowancePerPath: DEFAULT_CONFIG.scopeCallAllowancePerPath,
	scopeCallAllowanceMax: DEFAULT_CONFIG.scopeCallAllowanceMax,
};

describe('orchestration guide template', () => {
	it('is installed beside the agent definition files', () => {
		expect(ORCHESTRATION_GUIDE_FILENAME).toBe('subagent_orchestration.md');
	});

	it('ships with the role budget placeholder', () => {
		const template = fs.readFileSync(orchestrationGuideTemplatePath(), 'utf-8');
		expect(template).toContain('{{role_budgets}}');
	});
});

describe('roleBudgetLines', () => {
	it('states the budget of every role in call and token units', () => {
		const lines = roleBudgetLines(BUDGETS);
		expect(lines).toContain(
			'- Scout: up to 20 tool calls, of which at most 8 may be discovery reads',
		);
		expect(lines).toContain(
			'- Reviewer: up to 32 tool calls, of which at most 28 may be discovery reads',
		);
		expect(lines).toContain('about 4,000 output tokens');
		expect(lines).toContain('capped at 32 calls');
	});

	it('states the limits the extension enforces for every role the config prices', () => {
		const lines = roleBudgetLines(BUDGETS);
		for (const [role, budget] of Object.entries(DEFAULT_ROLE_BUDGETS)) {
			const label = role.replace(/^./, (first) => first.toUpperCase());
			const limits = roleBudgetFor(role, DEFAULT_CONFIG);
			expect(limits).toEqual(budget);
			expect(lines).toContain(
				`- ${label}: up to ${limits.toolCalls.toLocaleString('en-US')} tool calls, of which at most ${limits.discoveryCalls.toLocaleString('en-US')} may be discovery reads`,
			);
		}
	});

	it('follows a config override instead of the shipped defaults', () => {
		const reviewer: RoleBudget = {
			...DEFAULT_ROLE_BUDGETS.reviewer,
			toolCalls: 44,
			outputTokens: 6000,
		};
		const lines = roleBudgetLines({ ...BUDGETS, roleBudgets: { reviewer } });
		expect(lines).toContain('- Reviewer: up to 44 tool calls');
		expect(lines).toContain('about 6,000 output tokens');
		expect(lines).not.toContain('- Reviewer: up to 32 tool calls');
	});

	it('renders the validator pass limit from the budget instead of a stale constant', () => {
		const validator: RoleBudget = {
			...DEFAULT_ROLE_BUDGETS.validator,
			fullValidationPasses: 5,
		};
		const lines = roleBudgetLines({ ...BUDGETS, roleBudgets: { validator } });
		expect(lines).toContain('up to 5 full validation passes');
		expect(lines).not.toContain('up to 3 full validation passes');
	});

	it('marks the budget block as config at install time rather than live truth', () => {
		const lines = roleBudgetLines(BUDGETS);
		// The installed guide is a snapshot, so the block has to say which clock it runs on.
		expect(lines).toContain('when this guide was installed');
		expect(lines).toContain('stale on this page');
		expect(lines).toContain('`subagent_stats` reports what a session actually spent');
	});

	it('keeps the validation discipline notes attached to the roles that own them', () => {
		const lines = roleBudgetLines(BUDGETS);
		expect(lines).toContain('at most 12 discovery reads before the first implementation change');
		expect(lines).toContain('run at most 2 full validation passes');
		expect(lines).toContain(
			'Resolve the refs in the ledger before executing anything, up to 3 full validation passes',
		);
		expect(lines).toContain('execute only what no live ref covers');
	});
});

describe('composition policy guidance', () => {
	it('uses real line breaks and includes every actionable shared rule', () => {
		const lines = compositionPolicyLines();
		expect(lines).toContain('\n- R1 ');
		expect(lines).toContain('\n- R2 ');
		expect(lines).toContain('\n- R3 ');
		expect(lines).toContain('\n- R4 ');
		expect(lines).toContain('worker verify ref');
		expect(lines).toContain('parallel fan-out reviewers need non-empty, disjoint scope.paths');
		expect(lines).toContain('evidenceScope: "session"');
		expect(lines).toContain('preceding planner');
		expect(lines).toContain('Delegate later only when independent execution is needed.');
		expect(lines).toContain('Assign disjoint paths or use one reviewer.');
		expect(lines).toContain('Pass session scope or omit the validator.');
		expect(lines).toContain(
			'Use a sequential chain with a completed planner before the worker or use a lower tier.',
		);
		expect(lines).not.toContain('\\n');
	});

	it('renders composition guidance into the generated guide with real line breaks', () => {
		const guide = renderOrchestrationGuide(BUDGETS);
		expect(guide).toContain('## Composition policy\n\n');
		expect(guide).toContain('\n- R1 ');
		expect(guide).not.toContain('\\n- R1');
	});
});

describe('renderOrchestrationGuide', () => {
	const guide = renderOrchestrationGuide(BUDGETS);

	it('states that the guide is read on demand and names the triggers', () => {
		// The system-prompt mandate is gone, so the guide itself has to carry when it applies.
		expect(guide).toContain('read on demand rather than before every delegation');
		expect(guide).toContain(
			'a tier 2 or higher workflow, a parallel fan-out, or a remediation round',
		);
	});

	it('substitutes the budgets and leaves no placeholder behind', () => {
		expect(guide).not.toContain('{{role_budgets}}');
		expect(guide).toContain('- Reviewer: up to 32 tool calls');
	});

	it('renders every budget number in the guide from the config it is given', () => {
		const roles = {
			scout: { ...DEFAULT_ROLE_BUDGETS.scout, toolCalls: 23, outputTokens: 4100 },
			reviewer: { ...DEFAULT_ROLE_BUDGETS.reviewer, toolCalls: 37 },
			worker: { ...DEFAULT_ROLE_BUDGETS.worker, fullValidationPasses: 4 },
			validator: { ...DEFAULT_ROLE_BUDGETS.validator, fullValidationPasses: 6 },
		};
		const custom = renderOrchestrationGuide({
			roleBudgets: roles,
			scopeCallAllowancePerPath: 11,
			scopeCallAllowanceMax: 40,
		});
		// Each number moves independently, which only holds when the render reads config.
		expect(custom).toContain('- Scout: up to 23 tool calls');
		expect(custom).not.toContain('- Scout: up to 20 tool calls');
		expect(custom).toContain('about 4,100 output tokens');
		expect(custom).toContain('- Reviewer: up to 37 tool calls');
		expect(custom).not.toContain('- Reviewer: up to 32 tool calls');
		expect(custom).toContain('run at most 4 full validation passes');
		expect(custom).not.toContain('run at most 2 full validation passes');
		expect(custom).toContain('up to 6 full validation passes');
		expect(custom).not.toContain(
			'Resolve the refs in the ledger before executing anything, up to 3 full validation passes',
		);
		expect(custom).toContain('capped at 40 calls');
		expect(custom).not.toContain('capped at 32 calls');
		expect(custom).not.toContain('{{role_budgets}}');
		// The default render is untouched by the override above.
		expect(guide).toContain('- Scout: up to 20 tool calls');
		expect(guide).toContain('- Reviewer: up to 32 tool calls');
	});

	it('never reports report size in words', () => {
		expect(guide).not.toMatch(/\b\d[\d,]*-word\b/);
		expect(guide).toContain('output tokens');
	});

	it('keeps the rendered guide inside the measured token target', () => {
		// analysis/MEASUREMENT.md prices the rendered guide at one estimated token per four
		// chars, and the W8 target is under 6,000 estimated tokens: 24,000 rendered chars.
		// The budgets stay in the count, so the guide has to earn its size elsewhere.
		expect(guide.length).toBeLessThan(24000);
	});

	it('keeps the ledger contract that agent prompts depend on', () => {
		for (const field of [
			'validation_refs:',
			'evidence_refs:',
			'session_strategy:',
			'finding_scope:',
			'budget:',
		]) {
			expect(guide).toContain(field);
		}
		expect(guide).toContain('delegation_status = success | error | blocked | unknown');
		expect(guide).toContain('validation_verdict = PASS | FAIL | BLOCKED | NOT_RUN');
	});

	it('keeps the role and workflow contract intact', () => {
		expect(guide).toContain('### Tier 3 - Full investigation and assurance');
		expect(guide).toContain(
			'The reviewer audits implementation, tests, acceptance criteria, and validation evidence without executing project checks.',
		);
		expect(guide).toContain('Only the primary reviewer owns the final release decision.');
		expect(guide).toContain('Call `subagent` with `listSubagents: true`.');
	});

	// F-004: the main session owns the reuse decision, so the numbers it decides against stay in
	// the text it reads, not only in the child prompts and tool descriptions.
	it('states the quantitative session-reuse thresholds', () => {
		const reuse = guide.slice(guide.indexOf('## Subagent session discovery and reuse'));
		expect(reuse).toContain('context is above 100k tokens');
		expect(reuse).toContain('the session exceeds 8 turns');
	});

	it('states the compact parallel fan-out ownership rule', () => {
		const fanOut = guide.slice(guide.indexOf('#### Parallel fan-out and validation'));
		expect(fanOut.length).toBeGreaterThan(0);
		expect(guide.indexOf('#### Parallel fan-out and validation')).toBeGreaterThan(
			guide.indexOf('#### Validation references'),
		);
		expect(fanOut).toContain('One session owns the composite gate for the combined state');
		expect(fanOut).toContain('Siblings run focused read-only checks or none');
		expect(fanOut).toContain('do not run write-capable checks concurrently');
		expect(fanOut).toContain('Declare disjoint files');
		expect(fanOut).toContain('report sibling edits as contention');
		expect(fanOut).toContain(
			'Use separate worktrees when every sibling needs independent full evidence.',
		);
	});

	it('calls write-capable exactly the commands enforcement excludes from a concurrent sibling', () => {
		// The fan-out rule promises that write-capable commands run in at most one sibling at a time.
		// What is promiseable in code is the classification, so it is asserted here rather than paraphrased.
		expect(isExclusiveWriteCommandId('node_format')).toBe(true);
		expect(isExclusiveWriteCommandId('node_lint:fix')).toBe(true);
		expect(isExclusiveWriteCommandId('node_lint:reformat')).toBe(true);
		expect(verifySetsScriptOverrides({ scripts: { format: 'format' } })).toBe(true);
		// A build writes generated output, which the fan-out rule lists as shared mutable state.
		expect(isExclusiveWriteCommandId('node_build')).toBe(true);
		// The focused read-only checks a sibling is allowed to run are not write-capable.
		expect(isExclusiveWriteCommandId('node_format:check')).toBe(false);
		expect(isExclusiveWriteCommandId('node_lint:check')).toBe(false);
		expect(isExclusiveWriteCommandId('node_test')).toBe(false);
		expect(isExclusiveWriteCommandId('fallow_health')).toBe(false);
		expect(verifySetsScriptOverrides({ ref: 'vr_probe' })).toBe(false);
		expect(verifySetsScriptOverrides({ paths: ['src/guide.ts'] })).toBe(false);
		expect(verifySetsScriptOverrides({})).toBe(false);
	});

	it('states the compact validation reference contract', () => {
		expect(guide).toContain('Consumers resolve refs instead of rerunning covered checks');
		expect(guide).toContain('resolving a ref is not a validation pass');
		expect(guide).toContain('Report freshness as `executed`, `reused`, or `resolved`.');
		expect(guide).toContain(STALE_REF_RULE);
		expect(guide).toContain('A matching reference is evidence reuse, not code approval.');
	});

	it('keeps validation references ordered from issuance to reuse', () => {
		const refs = guide.slice(guide.indexOf('#### Validation references'));
		const ordered = [
			'Validation evidence is tool-issued',
			'Consumers resolve refs instead of rerunning covered checks',
			'Report freshness as `executed`, `reused`, or `resolved`',
			'A resolved ref is evidence only when its lookup succeeded',
			'Use a compact `V-###` fingerprint only when the project has no composite `verify` gate',
		];
		const positions = ordered.map((sentence) => refs.indexOf(sentence));
		expect(positions.every((position) => position >= 0)).toBe(true);
		expect(positions).toEqual(positions.toSorted((left, right) => left - right));
		expect(guide).toContain('Refs minted in a delegation flow resolve for its siblings');
		expect(guide).toContain('travel upward through `validation_refs`');
	});

	it('names the freshness of every reported check', () => {
		expect(guide).toContain('`executed` means this role ran the command');
		expect(guide).toContain(
			'`reused` means this role ran `verify` and the tool returned stored evidence',
		);
		expect(guide).toContain(
			'`resolved` means this role called `verify` with `{ ref }` and executed nothing',
		);
	});

	it('states the shortened validation ownership guidance', () => {
		expect(guide).toContain(
			'The session that modifies files, or the session integrating a parallel fan-in, owns the final gate',
		);
		expect(guide).toContain('Resolve live refs first, execute only uncovered checks once');
		expect(guide).toContain('The remainder is `node_build`, applicable `fallow_*` analyses');
		expect(guide).not.toContain('node_format:check');
	});

	it('runs the tiers without a default validator and names the independence knob', () => {
		expect(guide).toContain('worker(initial)\n  -> reviewer(primary)');
		expect(guide).toContain('planner(initial)\n  -> worker(initial)\n    -> reviewer(primary)');
		expect(guide).toContain('No validator. The worker `verify` ref is the validation evidence.');
		expect(guide).toContain(
			'Add a validator only when validation complexity is Medium or High, or independence is required.',
		);
		expect(guide).toContain(
			'Tier 3 keeps the validator. Pass `evidenceScope: "session"` on the validator delegation',
		);
		expect(guide).toContain('Plan validation as one composite `verify` ref plus one review owner.');
		expect(guide).toContain('consumers resolve refs rather than rerunning covered checks.');
	});

	it('drops the validator from targeted remediation', () => {
		expect(guide).toContain('worker(remediation)\n  -> reviewer(remediation)');
		expect(guide).not.toContain(
			'worker(remediation)\n  -> validator(remediation)\n    -> reviewer(remediation)',
		);
		expect(guide).toContain(
			'Add `validator(remediation)` only when the workflow already carries a validator',
		);
		expect(guide).toContain('it resolves the worker refs for every finding ID first');
	});

	it('keeps the validator and reviewer handoff contract', () => {
		expect(guide).toContain(
			'- Worker `verify` refs with their verdicts, `covers` lists, and repository state',
		);
		expect(guide).toContain('- Required `AC-###` and `F-###` ids');
		expect(guide).toContain('- The evidence scope in force');
		expect(guide).toContain(
			'The reviewer audits implementation, tests, acceptance criteria, and validation evidence',
		);
		expect(guide).toContain('Only the primary reviewer owns the final release decision.');
	});
});
