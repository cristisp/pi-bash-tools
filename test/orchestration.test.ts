import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, getConfig } from '../src/config.ts';
import {
	delegationFromEntry,
	deriveFlowId,
	ENV_CRITERIA,
	ENV_DELEGATION,
	ENV_EVIDENCE_SCOPE,
	ENV_FLOW,
	ENV_MODE,
	ENV_ROLE,
	ENV_REVIEW_MODE,
	ENV_SCOPE_PATHS,
	ENV_TIER,
	evidenceScopeForRole,
	isOpaqueId,
	narrowEvidenceScope,
	newDelegationId,
	orchestrationEnv,
	resolveDelegation,
	sanitizeCriteria,
} from '../src/delegation.ts';
import {
	ensureFlow,
	flowDirFor,
	flowsRoot,
	flowReportsDir,
	pruneFlows,
	recordFlowParticipant,
} from '../src/flow.ts';
import {
	appendTelemetryRecord,
	buildTelemetryRecord,
	readTelemetryRecords,
	telemetryPath,
} from '../src/telemetry.ts';
import { listSubagents, registerEntry } from '../src/registry.ts';
import { REGISTRY_PATH } from '../src/registry-store.ts';
import type { RegistryEntry } from '../src/types.ts';
import {
	makeMetrics,
	makeRegistryEntry,
	makeSingleResult,
	makeTempDir,
	stubEnv,
} from './helpers.ts';

afterEach(() => {
	vi.unstubAllEnvs();
});

function isolatedAgentDir(): string {
	const dir = makeTempDir();
	stubEnv(dir);
	return dir;
}

describe('newDelegationId', () => {
	it('mints unique opaque delegation ids', () => {
		const ids = new Set(Array.from({ length: 20 }, () => newDelegationId()));
		expect(ids.size).toBe(20);
		for (const id of ids) expect(isOpaqueId(id)).toBe(true);
	});
});

describe('deriveFlowId', () => {
	it('is stable for one root session and opaque', () => {
		const first = deriveFlowId('/sessions/root.jsonl');
		expect(first).toBe(deriveFlowId('/sessions/root.jsonl'));
		expect(first).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
	});

	it('differs across root sessions', () => {
		expect(deriveFlowId('/sessions/a.jsonl')).not.toBe(deriveFlowId('/sessions/b.jsonl'));
	});

	it('is undefined without a parent session', () => {
		expect(deriveFlowId(undefined)).toBeUndefined();
	});
});

describe('narrowEvidenceScope', () => {
	it('keeps the configured scope when nothing is requested', () => {
		expect(narrowEvidenceScope('flow')).toBe('flow');
		expect(narrowEvidenceScope('session')).toBe('session');
	});

	it('allows narrowing from flow to session', () => {
		expect(narrowEvidenceScope('flow', 'session')).toBe('session');
	});

	it('ignores widening from session to flow', () => {
		expect(narrowEvidenceScope('session', 'flow')).toBe('session');
	});
});

describe('evidenceScopeForRole', () => {
	it('applies per-role overrides from config', () => {
		expect(evidenceScopeForRole('validator', DEFAULT_CONFIG)).toBe('flow');
		expect(evidenceScopeForRole('worker', DEFAULT_CONFIG)).toBe('flow');
		expect(
			evidenceScopeForRole('validator', {
				evidenceScopeByRole: { validator: 'session' },
			}),
		).toBe('session');
	});

	it('narrows a validator to session scope so it cannot resolve sibling refs', () => {
		expect(narrowEvidenceScope(evidenceScopeForRole('validator', DEFAULT_CONFIG), 'session')).toBe(
			'session',
		);
		expect(narrowEvidenceScope(evidenceScopeForRole('validator', DEFAULT_CONFIG), 'flow')).toBe(
			'flow',
		);
	});

	it('ignores inherited object properties', () => {
		expect(evidenceScopeForRole('constructor', { evidenceScopeByRole: {} })).toBe('flow');
	});

	it('falls back to the default scope for invalid values', () => {
		expect(
			evidenceScopeForRole('worker', {
				evidenceScopeByRole: { worker: 'everything' as never },
				evidenceScopeDefault: 'session',
			}),
		).toBe('session');
	});
});

describe('resolveDelegation', () => {
	it('allocates a delegation id and derives the flow from the parent session', () => {
		const delegation = resolveDelegation({ role: 'worker', parentSession: '/sessions/root.jsonl' });
		expect(isOpaqueId(delegation.delegationId)).toBe(true);
		expect(delegation.flowId).toBe(deriveFlowId('/sessions/root.jsonl'));
		expect(delegation.role).toBe('worker');
	});

	it('omits the flow when there is no parent session', () => {
		expect(resolveDelegation({ role: 'worker' }).flowId).toBeUndefined();
	});

	it('keeps an existing delegation id and replaces a malformed one', () => {
		const kept = resolveDelegation({ role: 'worker', delegationId: ' delegation-1 ' });
		expect(kept.delegationId).not.toBe(' delegation-1 ');
		const reused = resolveDelegation({ role: 'worker', delegationId: 'delegation-1' });
		expect(reused.delegationId).toBe('delegation-1');
	});

	it('records orchestration context', () => {
		const delegation = resolveDelegation({
			role: 'reviewer',
			orchestration: {
				tier: 3,
				workflowMode: 'remediation',
				reviewMode: 'security',
				acceptanceCriteria: ['F-001'],
				compositionBoundaryId: 'boundary-uuid',
			},
		});
		expect(delegation).toMatchObject({
			tier: 3,
			workflowMode: 'remediation',
			reviewMode: 'security',
			acceptanceCriteria: ['F-001'],
			compositionBoundaryId: 'boundary-uuid',
			evidenceScope: 'flow',
		});
		expect(
			resolveDelegation({
				role: 'reviewer',
				orchestration: { compositionBoundaryId: 'not opaque' },
			}).compositionBoundaryId,
		).toBeUndefined();
	});

	it('narrowing wins over the configured role scope', () => {
		const delegation = resolveDelegation({
			role: 'worker',
			policy: DEFAULT_CONFIG,
			orchestration: { evidenceScope: 'session' },
		});
		expect(delegation.evidenceScope).toBe('session');
	});

	it('refuses to widen past the configured role scope', () => {
		const delegation = resolveDelegation({
			role: 'validator',
			policy: { evidenceScopeDefault: 'session', evidenceScopeByRole: {} },
			orchestration: { evidenceScope: 'flow' },
		});
		expect(delegation.evidenceScope).toBe('session');
	});
});

describe('sanitizeCriteria', () => {
	it('drops malformed ids and duplicates', () => {
		expect(sanitizeCriteria(['F-001', 'F-001', 'has space', '', 'F-002'])).toEqual([
			'F-001',
			'F-002',
		]);
	});

	it('caps the number of recorded ids', () => {
		expect(sanitizeCriteria(Array.from({ length: 200 }, (_, i) => `F-${i}`))).toHaveLength(64);
	});
});

describe('orchestrationEnv', () => {
	it('exports the identity contract', () => {
		const env = orchestrationEnv({
			delegationId: 'd-1',
			flowId: 'f-1',
			role: 'worker',
			tier: 2,
			workflowMode: 'initial',
			reviewMode: 'primary',
			acceptanceCriteria: ['F-001', 'F-002'],
			evidenceScope: 'flow',
		});
		expect(env).toEqual({
			[ENV_DELEGATION]: 'd-1',
			[ENV_FLOW]: 'f-1',
			[ENV_ROLE]: 'worker',
			[ENV_TIER]: '2',
			[ENV_MODE]: 'initial',
			[ENV_REVIEW_MODE]: 'primary',
			[ENV_CRITERIA]: 'F-001,F-002',
			[ENV_EVIDENCE_SCOPE]: 'flow',
		});
	});

	it('exports the declared scope size so the child can size its inspection budget', () => {
		const env = orchestrationEnv({
			delegationId: 'd-1',
			role: 'reviewer',
			evidenceScope: 'flow',
			scope: { paths: ['src/a.ts', 'src/b.ts', 'src/c.ts'] },
		});
		expect(env[ENV_SCOPE_PATHS]).toBe('3');
	});

	it('omits unset fields so absence stays meaningful', () => {
		const env = orchestrationEnv({
			delegationId: 'd-1',
			role: 'scout',
			evidenceScope: 'session',
		});
		expect(env).toEqual({
			[ENV_DELEGATION]: 'd-1',
			[ENV_ROLE]: 'scout',
			[ENV_EVIDENCE_SCOPE]: 'session',
		});
	});
});

describe('delegationFromEntry', () => {
	it('inherits delegation identity across reuse turns', () => {
		const entry = makeRegistryEntry({
			delegationId: 'd-1',
			flowId: 'f-1',
			parentSession: '/sessions/root.jsonl',
			tier: 1,
			workflowMode: 'initial',
			acceptanceCriteria: ['F-001'],
			evidenceScope: 'flow',
		});
		const delegation = delegationFromEntry(entry);
		expect(delegation).toMatchObject({
			delegationId: 'd-1',
			flowId: 'f-1',
			role: 'worker',
			tier: 1,
			workflowMode: 'initial',
			acceptanceCriteria: ['F-001'],
			evidenceScope: 'flow',
		});
	});

	it('lets a reuse turn narrow but not widen the stored scope', () => {
		const entry = makeRegistryEntry({ delegationId: 'd-1', evidenceScope: 'session' });
		const widened = delegationFromEntry(entry, { orchestration: { evidenceScope: 'flow' } });
		expect(widened.evidenceScope).toBe('session');
	});

	it('lets a reuse turn update orchestration context', () => {
		const entry = makeRegistryEntry({ delegationId: 'd-1', tier: 1, workflowMode: 'initial' });
		const delegation = delegationFromEntry(entry, {
			orchestration: { tier: 2, workflowMode: 'remediation' },
		});
		expect(delegation).toMatchObject({ delegationId: 'd-1', tier: 2, workflowMode: 'remediation' });
	});

	it('backfills identity for entries written before the contract existed', () => {
		const entry = makeRegistryEntry({
			delegationId: undefined,
			parentSession: '/sessions/r.jsonl',
		});
		const delegation = delegationFromEntry(entry);
		expect(isOpaqueId(delegation.delegationId)).toBe(true);
		expect(delegation.flowId).toBe(deriveFlowId('/sessions/r.jsonl'));
	});
});

describe('flow store', () => {
	it('creates the flow directory, reports namespace, and manifest once', () => {
		const dir = isolatedAgentDir();
		const manifest = ensureFlow({ flowId: 'flow-1', rootSession: '/sessions/root.jsonl' });
		expect(manifest).toMatchObject({ v: 1, flowId: 'flow-1', rootSession: '/sessions/root.jsonl' });
		expect(fs.existsSync(flowReportsDir('flow-1'))).toBe(true);
		const onDisk = JSON.parse(
			fs.readFileSync(path.join(flowDirFor('flow-1'), 'flow.json'), 'utf-8'),
		);
		expect(onDisk.flowId).toBe('flow-1');
		const again = ensureFlow({ flowId: 'flow-1', rootSession: 'ignored' });
		expect(again?.createdAt).toBe(manifest?.createdAt);
		expect(again?.rootSession).toBe('/sessions/root.jsonl');
		expect(fs.readdirSync(path.join(dir, 'subagent-herdr', 'flows'))).toEqual(['flow-1']);
	});

	it('refuses flow ids that are not opaque', () => {
		isolatedAgentDir();
		expect(ensureFlow({ flowId: '../escape' })).toBeNull();
		expect(fs.existsSync(flowsRoot())).toBe(false);
	});

	it('records participants once and refreshes lastUsedAt', async () => {
		isolatedAgentDir();
		const created = ensureFlow({ flowId: 'flow-2' });
		recordFlowParticipant({ flowId: 'flow-2', label: 'worker-1', agent: 'worker' });
		await new Promise((resolve) => setTimeout(resolve, 2));
		recordFlowParticipant({ flowId: 'flow-2', label: 'worker-1', agent: 'worker' });
		recordFlowParticipant({ flowId: 'flow-2', label: 'reviewer-1', agent: 'reviewer' });
		const manifest = JSON.parse(
			fs.readFileSync(path.join(flowDirFor('flow-2'), 'flow.json'), 'utf-8'),
		);
		expect(manifest.participants.map((p: { label: string }) => p.label)).toEqual([
			'worker-1',
			'reviewer-1',
		]);
		expect(manifest.lastUsedAt).toBeGreaterThan(created?.createdAt ?? 0);
	});

	it('prunes only flows idle past retention', () => {
		isolatedAgentDir();
		ensureFlow({ flowId: 'fresh' });
		ensureFlow({ flowId: 'stale' });
		const staleManifest = path.join(flowDirFor('stale'), 'flow.json');
		const manifest = JSON.parse(fs.readFileSync(staleManifest, 'utf-8'));
		manifest.lastUsedAt = Date.now() - 20 * 24 * 60 * 60 * 1000;
		fs.writeFileSync(staleManifest, JSON.stringify(manifest));
		expect(pruneFlows(14)).toEqual(['stale']);
		expect(fs.existsSync(flowDirFor('stale'))).toBe(false);
		expect(fs.existsSync(flowDirFor('fresh'))).toBe(true);
	});

	it('does nothing when the store root is absent', () => {
		isolatedAgentDir();
		expect(pruneFlows(14)).toEqual([]);
	});
});

describe('telemetry store', () => {
	it('builds a record from the delegation and its result', () => {
		const delegation = resolveDelegation({
			role: 'worker',
			parentSession: '/sessions/root.jsonl',
			orchestration: { tier: 2, workflowMode: 'remediation', acceptanceCriteria: ['F-001'] },
		});
		const result = makeSingleResult({
			exitCode: 0,
			stopReason: 'stop',
			model: 'p/model:high',
			metrics: makeMetrics({ durationMs: 1200, toolCalls: 9, failedToolCalls: 2, turns: 4 }),
			usage: { ...makeSingleResult().usage, cost: 0.25, turns: 4, contextTokens: 50_000 },
		});
		const record = buildTelemetryRecord(
			{
				delegation,
				workspace: 'ws1',
				label: 'worker-1',
				agent: 'worker',
				reused: true,
				reuseCount: 2,
				outcome: 'settled',
				parentSession: '/sessions/root.jsonl',
				sessionFile: '/sessions/subagent-ws1-worker-1.jsonl',
				result,
			},
			1_700_000_000_000,
		);
		expect(record).toMatchObject({
			v: 1,
			at: 1_700_000_000_000,
			delegationId: delegation.delegationId,
			flowId: delegation.flowId,
			workspace: 'ws1',
			label: 'worker-1',
			role: 'worker',
			tier: 2,
			workflowMode: 'remediation',
			acceptanceCriteria: ['F-001'],
			evidenceScope: 'flow',
			reused: true,
			reuseCount: 2,
			outcome: 'settled',
			exitCode: 0,
			stopReason: 'stop',
			childModel: 'p/model:high',
			sessionFile: '/sessions/subagent-ws1-worker-1.jsonl',
			metrics: { durationMs: 1200, toolCalls: 9, failedToolCalls: 2, turns: 4 },
		});
		expect(record.usage.cost).toBe(0.25);
	});

	it('defaults missing metrics instead of writing a partial record', () => {
		const record = buildTelemetryRecord({
			delegation: { delegationId: 'd-1', role: 'worker', evidenceScope: 'session' },
			workspace: 'ws1',
			label: 'worker-1',
			agent: 'worker',
			reused: false,
			reuseCount: 0,
			outcome: 'failed',
			result: makeSingleResult({ exitCode: 1, messages: [] }),
		});
		expect(record.metrics).toMatchObject({
			durationMs: 0,
			toolCalls: 0,
			turns: 0,
			blockEvents: 0,
			approvalMs: 0,
			steerMs: 0,
		});
	});

	it('appends one JSON line per delegation and ignores junk on read', () => {
		isolatedAgentDir();
		const base = {
			workspace: 'ws1',
			label: 'worker-1',
			agent: 'worker',
			reused: false,
			reuseCount: 0,
			outcome: 'settled' as const,
			result: makeSingleResult({ metrics: makeMetrics({ toolCalls: 3 }) }),
		};
		for (const role of ['worker', 'reviewer'])
			appendTelemetryRecord(
				buildTelemetryRecord({
					...base,
					delegation: { delegationId: `d-${role}`, role, evidenceScope: 'flow' },
				}),
			);
		fs.appendFileSync(telemetryPath(), 'not json\n');
		appendTelemetryRecord(
			buildTelemetryRecord({
				...base,
				delegation: { delegationId: 'd-aborted', role: 'worker', evidenceScope: 'flow' },
				outcome: 'aborted',
			}),
		);
		const records = readTelemetryRecords();
		expect(records.map((r) => r.delegationId)).toEqual(['d-worker', 'd-reviewer', 'd-aborted']);
		expect(records.map((r) => r.outcome)).toEqual(['settled', 'settled', 'aborted']);
		expect(readTelemetryRecords(1).map((r) => r.delegationId)).toEqual(['d-aborted']);
		expect(fs.existsSync(`${telemetryPath()}.lock`)).toBe(false);
	});

	it('uses config defaults when the policy is omitted', () => {
		const dir = isolatedAgentDir();
		fs.writeFileSync(
			path.join(dir, 'subagent-herdr.config.json'),
			JSON.stringify({ evidenceScopeDefault: 'session' }),
		);
		expect(getConfig().evidenceScopeDefault).toBe('session');
		expect(evidenceScopeForRole('worker', getConfig())).toBe('session');
	});
});

function entryWithRun(): RegistryEntry {
	return makeRegistryEntry({ delegationId: 'd-1' });
}

describe('registry identity rendering', () => {
	it('shows identity and last-run spend in the verbose listing only', () => {
		try {
			fs.unlinkSync(REGISTRY_PATH);
		} catch {}
		const entry: RegistryEntry = {
			...entryWithRun(),
			flowId: 'f-1',
			tier: 2,
			workflowMode: 'remediation' as const,
			evidenceScope: 'session' as const,
			lastRun: {
				at: Date.now(),
				durationMs: 2000,
				toolCalls: 7,
				failedToolCalls: 1,
				repeatedReads: 2,
				turns: 3,
				cost: 0.1234,
				contextTokens: 1000,
				approvalMs: 1500,
			},
		};
		registerEntry(entry);
		const compact = listSubagents({ verbose: false });
		expect(compact).not.toContain('delegation:');
		const verbose = listSubagents({ verbose: true });
		expect(verbose).toContain('delegation:d-1');
		expect(verbose).toContain('flow:f-1');
		expect(verbose).toContain('tier:2');
		expect(verbose).toContain('mode:remediation');
		expect(verbose).toContain('evidence:session');
		expect(verbose).toContain(
			'lastRun{tools:7 tool-errors:1 rereads:2 turns:3 $0.1234 waiting:1.5s time:2.0s}',
		);
	});
});
