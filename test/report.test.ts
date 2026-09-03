import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flowReportsDir } from '../src/flow.ts';
import {
	buildReportDigest,
	estimateTokens,
	parseLedgerBlock,
	signalLines,
	tokensFromChars,
	writeRoleReport,
} from '../src/report.ts';
import type { DelegationContext } from '../src/types.ts';
import { makeTempDir, stubEnv } from './helpers.ts';

const LEGGED = `## Completed

Wired the digest.

\`\`\`text
workflow_version: 1
task_id: demo
attempt: 1
delegation_status: completed
validation_verdict: PASS
review_verdict: none
findings: []
budget: 4/0/1
\`\`\`
`;

const UNLEDGED = `## Validation Scope

Ran the checks.

Validation Verdict: PASS
Unverified checks: none
budget: 3/0/1
`;

function delegation(overrides: Partial<DelegationContext> = {}): DelegationContext {
	return {
		delegationId: 'd-1',
		role: 'worker',
		evidenceScope: 'flow',
		flowId: 'f123',
		tier: 2,
		workflowMode: 'initial',
		...overrides,
	};
}

describe('parseLedgerBlock', () => {
	it('parses the ledger fields from a fenced block', () => {
		const ledger = parseLedgerBlock(LEGGED);
		expect(ledger?.fields.delegation_status).toBe('completed');
		expect(ledger?.fields.validation_verdict).toBe('PASS');
		expect(ledger?.fields['task_id']).toBe('demo');
		expect(ledger?.block).toContain('workflow_version: 1');
	});

	it('prefers the last ledger-looking block', () => {
		const twice = `${LEGGED}\nrevision:\n\n\`\`\`text\nworkflow_version: 1\ndelegation_status: revised\n\`\`\`\n`;
		const ledger = parseLedgerBlock(twice);
		expect(ledger?.fields.delegation_status).toBe('revised');
	});

	it('returns null when no block carries the ledger marker', () => {
		expect(parseLedgerBlock('```ts\nconst a = 1;\n```')).toBeNull();
		expect(parseLedgerBlock('prose only')).toBeNull();
	});
});

describe('signalLines', () => {
	it('collects status-bearing lines once', () => {
		const lines = signalLines(`${UNLEDGED}\nValidation Verdict: PASS`);
		expect(lines).toContain('Validation Verdict: PASS');
		expect(lines.filter((l) => l === 'Validation Verdict: PASS')).toHaveLength(1);
	});

	it('caps the number of lines', () => {
		const many = Array.from(
			{ length: 20 },
			(_, i) => `- delegation_status: completed step ${i}`,
		).join('\n');
		expect(signalLines(many, 8)).toHaveLength(8);
	});
});

describe('buildReportDigest', () => {
	it('keeps the ledger verbatim and strips it from the body', () => {
		const built = buildReportDigest(LEGGED, 600);
		expect(built.ledgerParsed).toBe(true);
		expect(built.truncated).toBe(false);
		expect(built.digest).toContain('workflow_version: 1');
		expect(built.digest).toContain('Wired the digest.');
		expect(built.digest.match(/workflow_version/g)).toHaveLength(1);
	});

	it('surfaces status lines instead when the child emitted no ledger', () => {
		const built = buildReportDigest(UNLEDGED, 600);
		expect(built.ledgerParsed).toBe(false);
		expect(built.digest).toContain('no ledger block emitted');
		expect(built.digest).toContain('Validation Verdict: PASS');
	});

	it('bounds the digest and marks truncation', () => {
		const long = `${LEGGED}\n\n${'detail sentence '.repeat(4000)}`;
		const built = buildReportDigest(long, 200);
		expect(built.truncated).toBe(true);
		expect(built.tokens).toBeLessThanOrEqual(220);
		expect(built.digest).toContain('Digest truncated:');
		expect(built.digest).toContain('workflow_version: 1');
	});

	it('handles an empty report', () => {
		const built = buildReportDigest('', 600);
		expect(built.digest).toBe('');
		expect(built.truncated).toBe(false);
	});
});

describe('estimateTokens', () => {
	it('estimates from characters', () => {
		expect(estimateTokens('a'.repeat(40))).toBe(10);
		expect(tokensFromChars(41)).toBe(11);
	});
});

describe('writeRoleReport', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('writes the full report under the flow and returns its path', () => {
		const dir = makeTempDir();
		stubEnv(dir);
		const file = writeRoleReport({
			flowId: 'f123',
			label: 'worker-1',
			delegation: delegation(),
			output: LEGGED,
			now: 1700000000000,
		});
		expect(file).toBe(path.join(flowReportsDir('f123'), 'worker-1-1700000000000.md'));
		const written = fs.readFileSync(file as string, 'utf-8');
		expect(written).toContain('# Role report: worker-1 (worker)');
		expect(written).toContain('- delegation: d-1');
		expect(written).toContain('- mode: initial');
		expect(written).toContain('workflow_version: 1');
	});

	it('returns undefined without a flow id', () => {
		stubEnv(makeTempDir());
		expect(
			writeRoleReport({
				label: 'worker-1',
				delegation: delegation({ flowId: undefined }),
				output: LEGGED,
			}),
		).toBeUndefined();
	});

	it('returns undefined when the store is unwritable', () => {
		const blocker = makeTempDir();
		fs.writeFileSync(path.join(blocker, 'subagent-herdr'), 'not a directory');
		stubEnv(blocker);
		expect(
			writeRoleReport({
				flowId: 'f123',
				label: 'worker-1',
				delegation: delegation(),
				output: LEGGED,
			}),
		).toBeUndefined();
	});
});
