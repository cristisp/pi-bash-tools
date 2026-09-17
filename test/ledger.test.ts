import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureFlow } from '../src/flow.ts';
import { DEFAULT_CONFIG, configPath } from '../src/config.ts';
import {
	LEDGER_FIELDS,
	LEDGER_FOLD_FIELDS,
	appendLedgerRevision,
	ledgerPath,
	ledgerPointer,
	ledgerPrefixBlock,
	ledgerShapeBlock,
	ledgerTurnLine,
	nextAttempt,
	parseLedger,
} from '../src/ledger.ts';
import { AGENT_TEMPLATES } from '../src/templates.ts';
import type { DelegationContext } from '../src/types.ts';
import { makeTempDir, stubEnv } from './helpers.ts';

function delegation(overrides: Partial<DelegationContext> = {}): DelegationContext {
	return {
		delegationId: 'del-0001',
		flowId: 'f1234567890abcdef',
		role: 'worker',
		evidenceScope: 'flow',
		...overrides,
	};
}

function writeConfig(overrides: Record<string, unknown>): void {
	fs.writeFileSync(
		configPath(),
		JSON.stringify({ ...structuredClone(DEFAULT_CONFIG), ...overrides }),
	);
}

function read(): string {
	return fs.readFileSync(ledgerPath('f1234567890abcdef'), 'utf-8');
}

function dispatch(fields: Partial<DelegationContext> = {}, extra: Record<string, unknown> = {}) {
	return appendLedgerRevision({
		flowId: 'f1234567890abcdef',
		kind: 'dispatch',
		delegation: delegation(fields),
		reused: false,
		...extra,
	});
}

beforeEach(() => {
	writeConfig({});
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('ledgerShapeBlock', () => {
	it('renders every field from the code list in order', () => {
		const block = ledgerShapeBlock();
		const lines = block.split('\n').slice(1, -1);
		expect(lines).toHaveLength(LEDGER_FIELDS.length);
		expect(lines.map((line) => line.split(':')[0])).toEqual([...LEDGER_FIELDS]);
		expect(block).toContain('workflow_version: 1');
	});
});

describe('appendLedgerRevision', () => {
	beforeEach(() => {
		stubEnv(makeTempDir());
		ensureFlow({ flowId: 'f1234567890abcdef', rootSession: '/sess/root.jsonl' });
	});

	it('appends monotonic revisions and returns the pointer', () => {
		const first = dispatch({ taskId: 'T-001', acceptanceCriteria: ['AC-001', 'AC-002'] });
		const second = dispatch({ taskId: 'T-001' });
		expect(first?.revision).toBe(1);
		expect(second?.revision).toBe(2);
		expect(second?.path).toBe(ledgerPath('f1234567890abcdef'));

		const revisions = parseLedger(read());
		expect(revisions.map((revision) => revision.revision)).toEqual([1, 2]);
		expect(revisions[0]?.fields).toMatchObject({
			kind: 'dispatch',
			task_id: 'T-001',
			attempt: '1',
			acceptance_criteria: 'AC-001,AC-002',
			role: 'worker',
			scope: 'flow',
			delegation_id: 'del-0001',
		});
		expect(revisions[1]?.fields.attempt).toBe('2');
	});

	it('counts attempts per task identity', () => {
		const existing = [
			{ revision: 1, fields: { kind: 'dispatch', task_id: 'T-001' } },
			{ revision: 2, fields: { kind: 'result', task_id: 'T-001' } },
			{ revision: 3, fields: { kind: 'dispatch', task_id: 'T-002' } },
		];
		expect(nextAttempt(existing, 'T-001')).toBe(2);
		expect(nextAttempt(existing, 'T-002')).toBe(2);
		expect(nextAttempt(existing, 'T-003')).toBe(1);
		expect(nextAttempt(existing, undefined)).toBe(1);
	});

	it('keeps report prose out and folds only the allowlisted child fields', () => {
		appendLedgerRevision({
			flowId: 'f1234567890abcdef',
			kind: 'result',
			delegation: delegation({ taskId: 'T-001' }),
			reused: false,
			outcome: 'settled',
			toolCalls: 12,
			failedToolCalls: 2,
			turns: 3,
			reportPath: '/tmp/report.md',
			childFields: {
				delegation_status: 'completed',
				validation_verdict: 'PASS',
				validation_omitted: 'lint',
				budget: '4/0/1',
				free_prose: 'a wall of narrative that must not reach the ledger',
			},
		});
		const text = read();
		expect(text).toContain('delegation_status: completed');
		expect(text).toContain('validation_verdict: PASS');
		expect(text).toContain('validation_omitted: lint');
		expect(text).toContain('tool_calls: 12');
		expect(text).toContain('failed_tool_calls: 2');
		expect(text).toContain('report: /tmp/report.md');
		expect(text).not.toContain('free_prose');
		expect(text).not.toContain('wall of narrative');
		expect(LEDGER_FOLD_FIELDS).toContain('delegation_status');
	});

	it('flattens values and bounds them so one field cannot grow a ledger', () => {
		appendLedgerRevision({
			flowId: 'f1234567890abcdef',
			kind: 'result',
			delegation: delegation(),
			reused: false,
			childFields: { findings: `first\nsecond ${'x'.repeat(400)}` },
		});
		const findings = read()
			.split('\n')
			.find((line) => line.startsWith('findings:'));
		expect(findings).toBeDefined();
		expect(findings).not.toContain('\n');
		expect(findings?.length).toBeLessThan(220);
		expect(findings).toMatch(/\.\.\.$/);
	});

	it('drops the oldest revisions past the configured window', () => {
		writeConfig({ ledgerMaxRevisions: 2 });
		for (const round of [1, 2, 3]) {
			dispatch({ taskId: 'T-009', tier: round });
		}
		const text = read();
		expect(text).toContain('revision: 3');
		expect(text).toContain('revision: 2');
		expect(text).not.toMatch(/^## revision 1 -/m);
		expect(ledgerPointer('f1234567890abcdef')?.revision).toBe(3);
	});

	it('drops a torn trailing header and keeps numbering monotonic', () => {
		dispatch({ taskId: 'T-030' });
		const target = ledgerPath('f1234567890abcdef');
		// Rewriting the file needs delete plus create, not append: the file mode refuses append,
		// which is the point of D1. A torn header is what a crash mid-append looks like.
		const torn = `${fs.readFileSync(target, 'utf-8')}\n## revision 4 - dispatch - unfinished\n`;
		fs.rmSync(target);
		fs.writeFileSync(target, torn, { mode: 0o400 });
		expect(parseLedger(read()).map((revision) => revision.revision)).toEqual([1]);
		expect(dispatch({ taskId: 'T-030' })?.revision).toBe(2);
		const text = read();
		expect(text).not.toContain('unfinished');
		expect(parseLedger(text).map((revision) => revision.revision)).toEqual([1, 2]);
	});

	it('continues numbering from the high-water mark when the ledger is truncated', () => {
		dispatch({ taskId: 'T-031' });
		appendLedgerRevision({
			flowId: 'f1234567890abcdef',
			kind: 'result',
			delegation: delegation({ taskId: 'T-031' }),
			outcome: 'settled',
			reused: false,
		});
		fs.rmSync(ledgerPath('f1234567890abcdef'));
		fs.writeFileSync(ledgerPath('f1234567890abcdef'), '# Orchestration ledger\n', { mode: 0o400 });
		expect(dispatch({ taskId: 'T-031' })?.revision).toBe(3);
		expect(parseLedger(read()).map((revision) => revision.revision)).toEqual([3]);
	});

	it('is a no-op without a flow id', () => {
		expect(
			appendLedgerRevision({
				flowId: undefined,
				kind: 'dispatch',
				delegation: { ...delegation(), flowId: undefined },
			}),
		).toBeUndefined();
		expect(ledgerPointer(undefined)).toBeUndefined();
	});

	it('degrades silently when the store is unwritable', () => {
		const flowDirectory = ledgerPath('f1234567890abcdef').replace(/\/ledger\.md$/, '');
		fs.rmSync(flowDirectory, { recursive: true, force: true });
		fs.writeFileSync(flowDirectory, 'a file where the flow directory belongs');
		expect(dispatch({ taskId: 'T-010' })).toBeUndefined();
		expect(ledgerPointer('f1234567890abcdef')).toBeUndefined();
	});
});

const MUTATING_TOOLS = new Set(['write', 'edit', 'move', 'delete']);
const HERDR_TOOLS = new Set(['subagent', 'subagent_stats', 'subagent_close']);

function allowlist(role: string): string[] {
	return (AGENT_TEMPLATES.find((template) => template.name === role)?.tools ?? '')
		.split(',')
		.map((tool) => tool.trim())
		.filter(Boolean);
}

describe('ledger write protection (D1)', () => {
	it('refuses owner writes to the ledger file', () => {
		stubEnv(makeTempDir());
		ensureFlow({ flowId: 'f1234567890abcdef' });
		if (process.getuid?.() === 0) return;
		dispatch({ taskId: 'T-040' });
		const target = ledgerPath('f1234567890abcdef');
		expect(fs.statSync(target).mode & 0o777).toBe(0o400);
		expect(() => fs.writeFileSync(target, 'delegation_status: completed\n')).toThrow(/EACCES/);
		expect(parseLedger(fs.readFileSync(target, 'utf-8'))[0]?.fields.outcome).toBeUndefined();
	});

	it('still appends through its own temp-file path', () => {
		stubEnv(makeTempDir());
		ensureFlow({ flowId: 'f1234567890abcdef' });
		dispatch({ taskId: 'T-041' });
		dispatch({ taskId: 'T-041' });
		expect(parseLedger(read()).map((revision) => revision.revision)).toEqual([1, 2]);
	});

	it('keeps mutating tools away from roles that only inspect', () => {
		for (const role of ['scout', 'planner', 'reviewer', 'validator']) {
			const tools = allowlist(role);
			expect(tools.length).toBeGreaterThan(0);
			expect(tools).toContain('read');
			expect(tools.filter((tool) => MUTATING_TOOLS.has(tool))).toEqual([]);
		}
		// The one role that can edit files is covered by the file mode, not by its allowlist.
		expect(allowlist('worker')).toContain('write');
	});

	it('keeps the delegation tools out of every role allowlist', () => {
		for (const template of AGENT_TEMPLATES) {
			const tools = (template.tools ?? '').split(',').map((tool) => tool.trim());
			expect(tools.filter((tool) => HERDR_TOOLS.has(tool))).toEqual([]);
		}
	});
});

describe('ledger pointers', () => {
	it('names the path and revision in the prompt texts', () => {
		const pointer = { path: '/agent/subagent-herdr/flows/f1/ledger.md', revision: 7 };
		const prefix = ledgerPrefixBlock(pointer);
		expect(prefix).toContain('## Orchestration ledger');
		expect(prefix).toContain('Path: /agent/subagent-herdr/flows/f1/ledger.md');
		expect(prefix).toContain('Revision: 7');
		expect(prefix).toContain('read tool');
		expect(prefix).toContain('Never write to');
		expect(ledgerTurnLine(pointer)).toBe(
			'ledger: /agent/subagent-herdr/flows/f1/ledger.md@7 (refreshed turn pointer; use bounded recovery only for a named stale, rejected, ambiguous, or required evidence gap)',
		);
	});

	it('points at the newest revision only when one exists', () => {
		stubEnv(makeTempDir());
		ensureFlow({ flowId: 'f1234567890abcdef' });
		expect(ledgerPointer('f1234567890abcdef')).toBeUndefined();
		dispatch({ taskId: 'T-020' });
		expect(ledgerPointer('f1234567890abcdef')?.revision).toBe(1);
	});
});
