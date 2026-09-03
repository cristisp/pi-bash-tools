import * as fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configPath } from '../src/config.ts';
import { AGENT_TEMPLATES, renderAgentFile } from '../src/templates.ts';
import { makeTempDir, stubEnv } from './helpers.ts';

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
		expect(worker?.body).toContain('Validation references for checks the validator should confirm');
		expect(validator?.body).toContain(
			'The validator must report, for each supplied AC-### and required check',
		);
		expect(validator?.body).toContain('V-001: command | result | scope');
		expect(validator?.body).toContain('exact command, working directory, covered IDs');
		expect(validator?.body).toContain('diff hash or focused file hashes when available');
		expect(validator?.body).toContain('Mark fingerprints without hashes non-reusable');
		expect(validator?.body).toContain('Reuse evidence only when those inputs are unchanged');
		const reviewer = AGENT_TEMPLATES.find((t) => t.name === 'reviewer');
		expect(reviewer?.body).toContain('## Test integrity');
		expect(reviewer?.body).toContain('would fail for a plausible broken implementation');
		expect(reviewer?.body).toContain('Use up to 12 read-only inspection calls');
		expect(worker?.body).toContain(
			'Increment attempt and record what changed since the previous attempt',
		);
		expect(worker?.body).toContain(
			'Read the structured finding ledger from the pointer supplied by the delegating session',
		);
		expect(worker?.body).toContain('Use up to 24 implementation tool calls');
		expect(validator?.body).toContain('Run each unchanged command once by default');
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
