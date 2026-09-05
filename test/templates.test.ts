import * as fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configPath } from '../src/config.ts';
import { AGENT_TEMPLATES, renderAgentFile } from '../src/templates.ts';
import { makeTempDir, stubEnv } from './helpers.ts';

function section(body: string, heading: string): string {
	const start = body.indexOf(`${heading}\n\n`);
	if (start === -1) throw new Error(`missing section: ${heading}`);
	const rest = body.slice(start + heading.length + 2);
	const next = rest.search(/\n## /);
	return next === -1 ? rest : rest.slice(0, next);
}

describe('renderAgentFile', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('renders current role budgets when configuration changes after module load', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		fs.writeFileSync(
			configPath(),
			JSON.stringify({ roleBudgets: { worker: { toolCalls: 3, fullValidationPasses: 1 } } }),
		);
		const worker = AGENT_TEMPLATES.find((template) => template.name === 'worker');
		const out = renderAgentFile(worker!);

		expect(out).toContain('Use up to 3 implementation tool calls');
		expect(out).toContain('no more than 1 full validation passes');
		expect(out).toContain('Live enforcement limits for worker: tool calls 3');
		expect(out).toContain(
			'Before the first implementation tool call, use no more than 12 discovery calls',
		);
		expect(out).not.toContain('Use up to 24 implementation tool calls');
		expect(out).not.toContain('Live enforcement limits for worker: tool calls 24');
	});

	it('renders frontmatter with name, description, and tools but no model', () => {
		const out = renderAgentFile(AGENT_TEMPLATES[0]);
		expect(out).toContain('---');
		expect(out).toContain('name: planner');
		expect(out).toContain(
			'description: Creates implementation plans from context and requirements',
		);
		expect(out).toContain(
			'tools: read, grep, find, ls, git_status, git_diff, git_log, git_show, codegraph_explore',
		);
		expect(out).not.toContain('model:');
		expect(out).toContain('## Goal');
	});
	it('omits tools when the template has none', () => {
		const out = renderAgentFile({
			filename: 'x.md',
			name: 'x',
			description: 'd',
			body: 'body text',
		});
		expect(out).not.toContain('tools:');
		expect(out).toContain('body text');
	});
	it('includes the validator in the standard templates', () => {
		expect(AGENT_TEMPLATES.map((t) => t.name)).toEqual([
			'planner',
			'reviewer',
			'scout',
			'worker',
			'validator',
		]);
	});
	it('includes pointer-based ledger guidance and the child output contract', () => {
		const ledgerFields = [
			'workflow_version:',
			'task_id:',
			'attempt:',
			'workflow_tier:',
			'workflow_mode:',
			'review_mode:',
			'delegation_status:',
			'validation_verdict:',
			'review_verdict:',
			'session_strategy:',
			'session_strategy_reason:',
			'finding_scope:',
			'acceptance_criteria:',
			'scope:',
			'out_of_scope:',
			'evidence_refs:',
			'invariants:',
			'changed_files:',
			'validation_refs:',
			'findings:',
			'baseline_failures:',
			'environment_blockers:',
			'unresolved_questions:',
			'transition_reason:',
			'recommended_next_action:',
			'budget:',
		];
		for (const t of AGENT_TEMPLATES) {
			expect(t.body, `${t.name} must carry workflow classification guidance`).toContain(
				'## Workflow classification',
			);
			expect(t.body, `${t.name} must read the supplied ledger pointer`).toContain(
				'Read the ledger at the pointer you were given',
			);
			expect(t.body, `${t.name} must describe the child ledger contribution`).toContain(
				'Your response must include one fenced machine-readable ledger block',
			);
			expect(t.body, `${t.name} must not expect a ledger in the task`).not.toContain(
				'The task should include a structured finding ledger',
			);
			for (const field of ledgerFields) {
				expect(t.body, `${t.name} must carry ledger field ${field}`).toContain(field);
			}
			expect(t.body, `${t.name} must use stable acceptance criteria IDs`).toContain('AC-001');
			expect(t.body, `${t.name} must use stable finding IDs`).toContain('F-001');
			expect(t.body, `${t.name} must not duplicate codegraph guidance`).not.toContain(
				'## Codegraph usage',
			);
			expect(t.body, `${t.name} must preserve compaction state`).toContain(
				'If context pressure or compaction occurs',
			);
			expect(t.body, `${t.name} must carry reuse guidance`).toContain(
				'Session reuse is an explicit optimization, not the default',
			);
			expect(t.body, `${t.name} must recommend worker reuse selectively`).toContain(
				'Prefer reuse for same-role worker continuation',
			);
			expect(t.body, `${t.name} must protect independent roles`).toContain(
				'Prefer a fresh session for planning, scouting, review, validation, security, audit',
			);
			expect(t.body, `${t.name} must require stats before reuse`).toContain(
				'inspect `subagent_stats`',
			);
			expect(t.body, `${t.name} must not duplicate docs guidance`).not.toContain(
				'resolve-library-id first',
			);
		}
	});
	it('defines a compact worker-validator evidence contract', () => {
		const worker = AGENT_TEMPLATES.find((t) => t.name === 'worker');
		const validator = AGENT_TEMPLATES.find((t) => t.name === 'validator');
		expect(worker?.body).toContain('The worker must report, for each supplied AC-###');
		expect(worker?.body).toContain('prefer TDD: define or confirm contracts');
		expect(worker?.body).toContain('Workers must not change tests merely to make them pass');
		expect(worker?.body).toContain(
			'Tool-issued `verify` refs for checks the validator should confirm',
		);
		expect(validator?.body).toContain(
			'The validator must report, for each supplied AC-### and required check',
		);
		expect(validator?.body).toContain(
			'the fallback shape for projects with no composite `verify` gate',
		);
		expect(validator?.body).toContain('V-001: command | result | scope');
		expect(validator?.body).toContain('Each fallback fingerprint must include');
		expect(validator?.body).toContain(
			'The session that modified files owns execution of the validation gate and mints the ref',
		);
		expect(validator?.body).toContain(
			'Every other role consumes that ref instead of re-running the gate',
		);
		expect(validator?.body).toContain(
			'run the composite gate once with `verify` after the last implementation change',
		);
		expect(validator?.body).toContain('pass `covers` with the `AC-###` and `F-###` ids addressed');
		expect(worker?.body).toContain(
			'You mint the ref for the state you own; you do not hand back a claim of validation without one',
		);
		expect(worker?.body).toContain(
			'Report the freshness of every ref you cite as `executed`, `reused`, or `resolved`',
		);
		expect(validator?.body).toContain('and report the ref verbatim');
		expect(validator?.body).toContain('A ref is stale when its `repositoryState`');
		expect(validator?.body).toContain('head plus dirty digest');
		expect(validator?.body).toContain('a path excluded by `.gitignore` never moves it');
		expect(validator?.body).toContain(
			'A stale ref is reported `NOT_RUN` and then executed by whoever is allowed to execute',
		);
		expect(validator?.body).toContain(
			'A ref you resolved is not evidence that you validated anything',
		);
		expect(validator?.body).toContain('resolving a ref is not a validation pass');
		expect(validator?.body).toContain(
			'Report the freshness of every cited ref as `executed` when this role ran the command',
		);
		expect(validator?.body).toContain(
			'`reused` when this role ran `verify` and the tool returned stored evidence',
		);
		expect(validator?.body).toContain('or `resolved` when this role called `verify`');
		expect(validator?.body).toContain('A reference you cannot resolve is not evidence');
		expect(worker?.body).toContain('never assert a freshness you cannot establish');
		expect(validator?.body).toContain(
			'Resolve before you execute. Call `verify` with `{ ref }` for every ref in the ledger',
		);
		expect(validator?.body).toContain(
			'When your delegation says `evidenceScope: session`, resolve nothing and execute the gate',
		);
		expect(validator?.body).toContain('because independence was bought with that narrowing');
		expect(validator?.body).toContain('Run each remaining unchanged command once by default');
		expect(validator?.body).toContain('exact command, working directory, covered IDs');
		expect(validator?.body).toContain('diff hash or focused file hashes when available');
		expect(validator?.body).toContain('Mark fingerprints without hashes non-reusable');
		expect(validator?.body).toContain('Reuse evidence only when those inputs are unchanged');
		const reviewer = AGENT_TEMPLATES.find((t) => t.name === 'reviewer');
		expect(reviewer?.body).toContain('## Test integrity');
		expect(reviewer?.body).toContain('would fail for a plausible broken implementation');
		expect(reviewer?.body).toContain('Use up to 32 read-only inspection calls');
		expect(reviewer?.body).toContain('token output budget (tokens, not words)');
		expect(reviewer?.body).toContain('The output-token limit counts report prose');
		expect(worker?.body).toContain(
			'Increment attempt and record what changed since the previous attempt',
		);
		expect(worker?.body).toContain(
			'Read the structured finding ledger from the pointer supplied by the delegating session',
		);
		expect(worker?.body).toContain('Use up to 24 implementation tool calls');
		expect(worker?.body).toContain(
			'Mint one `verify` ref for the final repository state after the last implementation change',
		);
		expect(worker?.body).toContain(
			'count that run as one full validation pass, and never re-run the gate for unchanged state',
		);
		expect(validator?.body).toContain(
			'Resolve the refs in the ledger first, then execute at most the uncovered remainder',
		);
		const scout = AGENT_TEMPLATES.find((t) => t.name === 'scout');
		const planner = AGENT_TEMPLATES.find((t) => t.name === 'planner');
		expect(scout?.body).toContain('Use up to 8 discovery queries');
		expect(planner?.body).toContain('Use up to 6 evidence-gap inspections');
	});
	it('gives the validator read-only validation tools', () => {
		const validator = AGENT_TEMPLATES.find((t) => t.name === 'validator');
		expect(validator?.tools).toContain('project_command');
		expect(validator?.tools).toContain('playwright');
		expect(validator?.body).toContain('BASELINE_FAILURE');
	});
	it('gives the verify gate to the roles that execute validation', () => {
		for (const role of ['worker', 'validator']) {
			const tools = (AGENT_TEMPLATES.find((t) => t.name === role)?.tools ?? '')
				.split(',')
				.map((tool) => tool.trim());
			expect(tools, `${role} must be able to run the verify gate`).toContain('verify');
		}
		for (const role of ['scout', 'planner']) {
			const tools = (AGENT_TEMPLATES.find((t) => t.name === role)?.tools ?? '')
				.split(',')
				.map((tool) => tool.trim());
			expect(tools, `${role} must not execute the verify gate`).not.toContain('verify');
		}
		const validatorTools = AGENT_TEMPLATES.find((t) => t.name === 'validator')?.tools ?? '';
		expect(validatorTools).toContain('project_command');
		expect(validatorTools).toContain('verify');
		const reviewerTools = (AGENT_TEMPLATES.find((t) => t.name === 'reviewer')?.tools ?? '')
			.split(',')
			.map((tool) => tool.trim());
		expect(reviewerTools, 'the reviewer must resolve refs').toContain('verify');
		expect(reviewerTools, 'the reviewer must not run project commands').not.toContain(
			'project_command',
		);
	});
	it('makes the worker mint the validation ref and the validator resolve it first', () => {
		const worker = AGENT_TEMPLATES.find((t) => t.name === 'worker')!;
		const validator = AGENT_TEMPLATES.find((t) => t.name === 'validator')!;

		const gate = section(worker.body, '## Validation gate');
		expect(gate).toContain('The session that modified files owns execution of the validation gate');
		expect(gate).toContain(
			'Run the composite gate once with `verify` after the last implementation change',
		);
		expect(gate).toContain('passing `covers` with the `AC-###` and `F-###` ids you addressed');
		expect(gate).toContain('report the ref verbatim');
		expect(gate).toContain('Do not run the gate twice for the same repository state');
		expect(gate).toContain('A ref you resolved is not evidence that you validated anything');
		expect(section(worker.body, '## Validation Attempted')).toContain(
			'Cite the tool-issued `verify` ref for every executed check, verbatim',
		);
		expect(section(worker.body, '## Validation Attempted')).toContain(
			'with its freshness: `executed`, `reused`, or `resolved`',
		);

		const policy = section(validator.body, '## Command policy');
		expect(policy.startsWith('Resolve before you execute.')).toBe(true);
		expect(policy.indexOf('Execute only what no live ref covers')).toBeGreaterThan(
			policy.indexOf('Resolve before you execute.'),
		);
		expect(policy).toContain('`verify` is the composite gate');
		expect(policy).toContain('format, lint, typecheck, and test');
		expect(policy).toContain(
			'Use `project_command` only for the remainder `verify` does not expose: `node_build`, the `fallow_*` analyses, and a phase the project has no script for',
		);
		expect(policy).toContain('formatter command is never remainder work');
		expect(policy).toContain(
			'Run a remainder check only when the plan or an acceptance criterion requires it',
		);
		expect(policy).not.toContain('node_format:check');
		expect(policy).toContain('A ref that is stale, covers no required id');
		expect(policy).toContain('is reported `NOT_RUN` and then executed');
		expect(policy).toContain(
			'evidenceScope: session`, resolve nothing and execute the gate yourself',
		);
		expect(policy).not.toContain('Use the fixed project-command tools');

		const process = section(validator.body, '## Validation process');
		expect(process).toContain('2. Resolve each ref with `verify` and `{ ref }`');
		expect(process.indexOf('6. Execute only the checks no live ref covers')).toBeGreaterThan(
			process.indexOf('2. Resolve each ref with `verify`'),
		);
		expect(process).toContain('Record the exact command, exit code, result, minted ref');

		const commands = section(validator.body, '## Commands');
		expect(commands).toContain('- Ref: Tool-issued `verify` ref cited verbatim');
		expect(commands).toContain('the fallback fingerprint when the project exposes no composite');
		expect(commands).toContain('- Freshness: executed, reused, or resolved');
	});
	it('keeps one gate owner per state when siblings implement in parallel', () => {
		const worker = AGENT_TEMPLATES.find((t) => t.name === 'worker')!;
		const validator = AGENT_TEMPLATES.find((t) => t.name === 'validator')!;

		const gate = section(worker.body, '## Validation gate');
		expect(gate).toContain(
			'the composite gate has one owner for the combined state, normally the session that integrates the fan-in',
		);
		expect(gate).toContain('attests to everyone');
		expect(gate).toContain('the only session permitted to write');
		// The mint mandate is qualified, so a fan-out never has N owners for one gate.
		expect(gate).toContain(
			'that owner is the single session integrating the fan-in rather than you',
		);
		expect(gate).toContain('report `validation_refs: none`, the composite check as `NOT_RUN`');

		const policy = section(validator.body, '## Command policy');
		expect(policy).toContain('Treat unexpected tracked changes as a validation failure.');
		expect(policy).toContain(
			'is contention, so name it as contention and re-check after the fan-in',
		);

		// The shared contract states the fan-out rule once, for both roles.
		for (const body of [worker.body, validator.body]) {
			expect(body).toContain(
				'Under a parallel fan-out the gate keeps exactly one owner for the combined state',
			);
			expect(body).toContain(
				'or under a parallel fan-out the single session that integrates the fan-in',
			);
			expect(body).toContain(
				'which is evidence about neither, so mint it after the last sibling lands',
			);
			expect(body).toContain('that refusal means retry, not report a blocker');
		}
	});
	it('keeps the reviewer on ref audit instead of re-execution', () => {
		const reviewer = AGENT_TEMPLATES.find((t) => t.name === 'reviewer')!;
		expect(section(reviewer.body, '## Validation Evidence')).toContain(
			'The reviewer audits refs and never re-executes them',
		);
		expect(section(reviewer.body, '## Validation Evidence')).toContain(
			'A required check with no live ref is a finding',
		);
		expect(section(reviewer.body, '## Validation Evidence')).toContain(
			'a ref cited with a freshness of `resolved` for a check that needed execution',
		);
		expect(section(reviewer.body, '## Validation Evidence')).toContain(
			'`verify` with `{ ref }` and nothing else',
		);
		expect(reviewer.body).toContain('refused by enforcement');
		const reviewerToolNames = (reviewer.tools ?? '').split(',').map((tool) => tool.trim());
		expect(reviewerToolNames, 'the reviewer must resolve refs').toContain('verify');
		expect(reviewerToolNames, 'the reviewer must not run project commands').not.toContain(
			'project_command',
		);
	});
	it('sends refs upward through the ledger validation_refs field', () => {
		for (const name of ['worker', 'validator']) {
			const role = AGENT_TEMPLATES.find((t) => t.name === name)!;
			expect(role.body).toContain('Record every ref you cite in the `validation_refs` field');
		}
		const worker = AGENT_TEMPLATES.find((t) => t.name === 'worker')!;
		expect(worker.body).toContain(
			'distinguish a check you executed from a check you cite only by ref',
		);
	});
	it('produces parseable frontmatter for every template', () => {
		for (const t of AGENT_TEMPLATES) {
			const out = renderAgentFile(t);
			expect(out.startsWith('---\n')).toBe(true);
			expect(out).toContain(`name: ${t.name}`);
			expect(out).toContain(`description: ${t.description}`);
			expect(out).not.toMatch(/model:/);
		}
	});
});
