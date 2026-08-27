import { describe, expect, it } from 'vitest';
import {
	AGENT_TEMPLATES,
	isValidModelSpec,
	normalizeModelSpec,
	renderAgentFile,
} from '../src/templates.ts';

describe('isValidModelSpec', () => {
	it('accepts provider/model specs', () => {
		expect(isValidModelSpec('github-copilot/gpt-5.6-luna')).toBe(true);
		expect(isValidModelSpec('cortecs/deepseek-v4-flash-0731')).toBe(true);
	});
	it('accepts thinking levels case-insensitively', () => {
		expect(isValidModelSpec('provider/model:high')).toBe(true);
		expect(isValidModelSpec('provider/model:High')).toBe(true);
		expect(isValidModelSpec('provider/model:off')).toBe(true);
		expect(isValidModelSpec('provider/model:max')).toBe(true);
	});
	it('rejects unknown levels and malformed specs', () => {
		expect(isValidModelSpec('provider/model:ultra')).toBe(false);
		expect(isValidModelSpec('no-slash')).toBe(false);
		expect(isValidModelSpec('/missing-provider')).toBe(false);
		expect(isValidModelSpec('provider/')).toBe(false);
		expect(isValidModelSpec('')).toBe(false);
		expect(isValidModelSpec('provider/model:')).toBe(false);
	});
});

describe('normalizeModelSpec', () => {
	it('lowercases valid thinking levels', () => {
		expect(normalizeModelSpec('p/m:HIGH')).toBe('p/m:high');
		expect(normalizeModelSpec('p/m:Low')).toBe('p/m:low');
	});
	it('leaves specs without levels untouched', () => {
		expect(normalizeModelSpec('p/m')).toBe('p/m');
	});
	it('trims whitespace', () => {
		expect(normalizeModelSpec('  p/m:high  ')).toBe('p/m:high');
	});
});

describe('renderAgentFile', () => {
	it('renders frontmatter with name, description, tools, and model', () => {
		const out = renderAgentFile(AGENT_TEMPLATES[0], 'test-model:high');
		expect(out).toContain('---');
		expect(out).toContain('name: planner');
		expect(out).toContain(
			'description: Creates implementation plans from context and requirements',
		);
		expect(out).toContain(
			'tools: read, grep, find, ls, git_status, git_diff, git_log, git_show, codegraph_explore',
		);
		expect(out).toContain('model: test-model:high');
		expect(out).toContain('## Goal');
	});
	it('omits tools when the template has none', () => {
		const out = renderAgentFile(
			{ filename: 'x.md', name: 'x', description: 'd', body: 'body text' },
			'm',
		);
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
	it('includes workflow classification and ledger guidance without duplicating system guidance', () => {
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
			const out = renderAgentFile(t, 'm:high');
			expect(out.startsWith('---\n')).toBe(true);
			expect(out).toContain(`name: ${t.name}`);
			expect(out).toContain(`description: ${t.description}`);
			expect(out).toMatch(/model: m:high\n---/);
		}
	});
});
