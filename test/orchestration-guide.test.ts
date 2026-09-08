import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
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
		expect(guide).toContain('The reviewer must not call `codegraph_sync`.');
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

	it('owns the composite gate once per state in a parallel fan-out', () => {
		const fanOut = guide.slice(guide.indexOf('#### Parallel fan-out and validation'));
		expect(fanOut.length).toBeGreaterThan(0);
		expect(guide.indexOf('#### Parallel fan-out and validation')).toBeGreaterThan(
			guide.indexOf('#### Validation references'),
		);
		for (const rule of [
			'A gate executed by a sibling therefore attests to the union of the in-flight changes',
			'One session owns the gate for the combined state',
			'Siblings do not run the composite gate.',
			'Write-capable commands, meaning a formatter, a lint fix, or a `verify` phase override',
			'Being permitted to write the same file one after another is still a coordination defect',
			'one `git worktree` per worker',
		]) {
			expect(fanOut).toContain(rule);
		}
		expect(fanOut).toContain(
			're-check after the fan-in rather than failing the change under review',
		);
		// The generated budget bullets repeat the rule where the worker budget is stated.
		expect(guide).toContain(
			'When siblings implement in parallel, do not run the gate: the session that integrates the fan-in mints one ref for the combined state',
		);
		// The unconditional W7 mint mandate is qualified everywhere it appears, so a fan-out
		// names one owner rather than one owner per modifying session.
		expect(guide).not.toContain('Only that session mints');
		expect(guide).toContain(
			'Under a parallel fan-out the owner is the single session that integrates the fan-in',
		);
		expect(guide).toContain(
			'or under a parallel fan-out the single session that integrates the fan-in owns it',
		);
		expect(guide).toContain('you report `validation_refs: none`, the composite check as `NOT_RUN`');
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

	it('states the validation reference rules the extension enforces', () => {
		expect(guide).toContain('Resolving a reference is not a validation pass');
		expect(guide).toContain('reports `reused: true` is stored evidence, not fresh execution');
		expect(guide).toContain('references travel from child to parent and never the other way round');
		expect(guide).toContain('A matching reference is evidence reuse, not code approval.');
	});

	it('leads with the tool-issued ref and demotes the fingerprint to the fallback shape', () => {
		const refs = guide.slice(guide.indexOf('#### Validation references'));
		const ordered = [
			'The reference is tool-issued.',
			'Resolve before you execute.',
			'A reference is stale when the repository state it names',
			'A reference you cannot resolve is not evidence',
			'no composite `verify` gate, record a compact `V-###` reference',
		];
		const positions = ordered.map((sentence) => refs.indexOf(sentence));
		expect(positions.every((position) => position >= 0)).toBe(true);
		expect(positions).toEqual(positions.toSorted((left, right) => left - right));
		expect(guide).toContain(
			'the session that modified files mints the reference by running the gate once',
		);
		expect(guide).toContain('References travel upward in the ledger `validation_refs` field');
		expect(guide).toContain('the validator and the reviewer are its consumers');
		expect(guide).toContain(
			'A stale reference is reported `NOT_RUN` and then executed by whoever is allowed to execute',
		);
		expect(guide).toContain(
			'execute it only if your role is permitted to execute, and never assert a freshness you cannot establish',
		);
		expect(guide).toContain('references travel from child to parent and never the other way round');
		expect(guide).toContain(
			'resolves for every sibling in that flow, observed as a worker minting and a validator seat resolving',
		);
		expect(guide).toContain('authorized without a prompt');
		expect(guide).toContain('a path excluded by `.gitignore` never moves it');
		expect(guide).toContain('its references are process-local and no child can resolve them');
		expect(guide).toContain(
			'either delegate the validation of that change or expect the child to report those checks as `NOT_RUN`',
		);
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

	it('makes the worker mint the evidence and the validator resolve it first', () => {
		expect(guide).toContain(
			'the session that modified files owns execution of the validation gate',
		);
		expect(guide).toContain('Mint the validation evidence');
		expect(guide).toContain('The validator resolves before it executes');
		expect(guide).toContain('Execute only what no live ref covers, once per command');
		expect(guide).toContain(
			'When your delegation says `evidenceScope: session`, resolve nothing and execute the gate yourself',
		);
		expect(guide).toContain(
			'The remainder is what `verify` does not expose: `node_build`, the `fallow_*` analyses, and a phase the project has no script for',
		);
		expect(guide).toContain(
			'Run a remainder check only when the plan or an acceptance criterion requires it',
		);
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
		expect(guide).toContain('the validation plan is one `verify` ref plus one review owner');
		expect(guide).toContain(
			'Never delegate a validator to re-run a deterministic gate a ref already covers',
		);
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

	it('carries the refs, required ids, and evidence scope into the validator task', () => {
		expect(guide).toContain(
			'- Worker `verify` refs with their verdicts, `covers` lists, and repository state',
		);
		expect(guide).toContain('- Required `AC-###` and `F-###` ids');
		expect(guide).toContain('- The evidence scope in force');
		expect(guide).toContain('The reviewer audits refs and never re-executes them');
		expect(guide).toContain('The reviewer calls `verify` with `{ ref }` and nothing else');
		expect(guide).toContain('the reviewer has no `project_command`');
		expect(guide).toContain('Exactly one primary reviewer owns the release decision');
	});
});
