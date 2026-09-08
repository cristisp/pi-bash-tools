import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { withFileLock } from './registry-store.ts';
import { makeEmptyUsage } from './types.ts';
import type {
	DelegationContext,
	ExecutionMetrics,
	LedgerRunInfo,
	ReportSummary,
	SingleResult,
	CompositionPolicy,
	CompositionVerdict,
	TelemetryRecord,
} from './types.ts';

export function telemetryPath(): string {
	return path.join(getAgentDir(), 'subagent-herdr.telemetry.jsonl');
}

export interface TelemetryInput {
	delegation: DelegationContext;
	workspace: string;
	label: string;
	agent: string;
	reused: boolean;
	reuseCount: number;
	outcome: 'settled' | 'failed' | 'aborted';
	parentSession?: string;
	sessionFile?: string;
	result: SingleResult;
	report?: ReportSummary;
	ledger?: LedgerRunInfo;
}

function metricsFallback(result: SingleResult): ExecutionMetrics {
	return {
		durationMs: 0,
		toolCalls: 0,
		failedToolCalls: 0,
		repeatedReads: 0,
		messageCount: result.messages.length,
		taskChars: result.task.length,
		outputChars: 0,
		maxContextTokens: 0,
		turns: 0,
		blockEvents: 0,
		approvalMs: 0,
		steerMs: 0,
	};
}

export function buildTelemetryRecord(input: TelemetryInput, now = Date.now()): TelemetryRecord {
	const { delegation, result } = input;
	const record: TelemetryRecord = {
		v: 1,
		at: now,
		delegationId: delegation.delegationId,
		workspace: input.workspace,
		label: input.label,
		agent: input.agent,
		role: delegation.role,
		evidenceScope: delegation.evidenceScope,
		reused: input.reused,
		reuseCount: input.reuseCount,
		outcome: input.outcome,
		exitCode: result.exitCode,
		usage: result.usage ?? makeEmptyUsage(),
		metrics: result.metrics ?? metricsFallback(result),
	};
	if (delegation.flowId) record.flowId = delegation.flowId;
	if (delegation.taskId) record.taskId = delegation.taskId;
	if (typeof delegation.tier === 'number') record.tier = delegation.tier;
	if (delegation.workflowMode) record.workflowMode = delegation.workflowMode;
	if (delegation.reviewMode) record.reviewMode = delegation.reviewMode;
	if (delegation.acceptanceCriteria?.length)
		record.acceptanceCriteria = delegation.acceptanceCriteria;
	if (input.parentSession) record.parentSession = input.parentSession;
	if (delegation.rootSession) record.rootSession = delegation.rootSession;
	if (delegation.compositionPolicy) record.compositionPolicy = delegation.compositionPolicy;
	if (delegation.compositionPolicyOverride)
		record.compositionPolicyOverride = delegation.compositionPolicyOverride;
	// Composition decisions are emitted as typed boundary events, not copied into every child
	// delegation record. This keeps ordinary child metrics and counts free of duplicate warnings.
	if (delegation.parentPaneId) record.parentPaneId = delegation.parentPaneId;
	if (delegation.scope) record.scope = delegation.scope;
	if (delegation.reviewSurfacePath) record.reviewSurfacePath = delegation.reviewSurfacePath;
	if (delegation.reviewSurfaceRevision !== undefined)
		record.reviewSurfaceRevision = delegation.reviewSurfaceRevision;
	if (delegation.reviewSurfaceRefreshed !== undefined)
		record.reviewSurfaceRefreshed = delegation.reviewSurfaceRefreshed;
	if (delegation.dirtyPaths?.length) record.dirtyPaths = delegation.dirtyPaths;
	if (result.readManifest) record.readManifest = result.readManifest;
	if (result.model) record.childModel = result.model;
	if (result.stopReason) record.stopReason = result.stopReason;
	if (input.sessionFile) record.sessionFile = input.sessionFile;
	if (input.ledger?.revision !== undefined) record.ledgerRevision = input.ledger.revision;
	if (input.ledger?.injection) record.ledgerInjection = input.ledger.injection;
	if (result.budget) record.budget = result.budget;
	const report = input.report;
	if (report) {
		const summary: ReportSummary = {
			tokens: report.tokens,
			digestTokens: report.digestTokens,
			truncated: report.truncated,
			ledgerParsed: report.ledgerParsed,
			filesReviewedPresent: report.filesReviewedPresent,
			filesReviewed: report.filesReviewed,
			contractIssues: report.contractIssues,
		};
		if (report.path) summary.path = report.path;
		record.report = summary;
	}
	return record;
}

export interface CompositionTelemetryInput {
	verdicts: CompositionVerdict[];
	workspace: string;
	parentSession?: string;
	flowId?: string;
	policy: CompositionPolicy;
	policyOverride?: CompositionPolicy;
	boundaryId?: string;
}

/**
 * Builds a boundary-only record for one composition verdict. It intentionally uses zero execution
 * metrics and a fresh delegation id so it cannot be mistaken for a completed child turn.
 */
export function buildCompositionTelemetryRecord(
	input: CompositionTelemetryInput,
	now = Date.now(),
): TelemetryRecord {
	const first = input.verdicts[0];
	const role = first?.role ?? first?.agent ?? 'composition';
	const delegation: DelegationContext = {
		delegationId: randomUUID(),
		role,
		evidenceScope: 'flow',
		...(input.flowId ? { flowId: input.flowId } : {}),
		compositionPolicy: input.policy,
		...(input.policyOverride ? { compositionPolicyOverride: input.policyOverride } : {}),
	};
	const isRefusal = first?.action === 'refuse';
	const result: SingleResult = {
		agent: first?.agent ?? role,
		agentSource: 'unknown',
		task: isRefusal ? 'composition boundary refusal' : 'composition boundary warning',
		exitCode: 0,
		messages: [],
		stderr: '',
		usage: makeEmptyUsage(),
		metrics: {
			durationMs: 0,
			toolCalls: 0,
			failedToolCalls: 0,
			repeatedReads: 0,
			messageCount: 0,
			taskChars: 0,
			outputChars: 0,
			maxContextTokens: 0,
			turns: 0,
			blockEvents: 0,
			approvalMs: 0,
			steerMs: 0,
		},
	};
	const record = buildTelemetryRecord(
		{
			delegation,
			workspace: input.workspace,
			label: 'composition-boundary',
			agent: result.agent,
			reused: false,
			reuseCount: 0,
			outcome: 'settled',
			parentSession: input.parentSession,
			result,
		},
		now,
	);
	record.event = 'composition';
	record.compositionVerdict = first;
	record.compositionBoundaryId = input.boundaryId;
	record.compositionBoundaryStatus = isRefusal ? 'refusal' : 'warning';
	return record;
}

/** Appends one JSONL record. Telemetry must never break a delegation. */
export function appendTelemetryRecord(record: TelemetryRecord): void {
	const file = telemetryPath();
	const lockPath = `${file}.lock`;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		withFileLock(lockPath, () => {
			fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: 'utf-8', mode: 0o600 });
		});
	} catch {}
}

export function appendCompositionTelemetry(input: CompositionTelemetryInput): void {
	if (input.verdicts.length === 0) return;
	const boundaryId = input.boundaryId ?? randomUUID();
	for (const verdict of input.verdicts) {
		appendTelemetryRecord(
			buildCompositionTelemetryRecord({ ...input, verdicts: [verdict], boundaryId }, Date.now()),
		);
	}
}

export function readTelemetryRecords(limit?: number): TelemetryRecord[] {
	let raw: string;
	try {
		raw = fs.readFileSync(telemetryPath(), 'utf-8');
	} catch {
		return [];
	}
	const records: TelemetryRecord[] = [];
	for (const line of raw.split('\n')) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line);
			if (parsed && parsed.v === 1 && typeof parsed.delegationId === 'string')
				records.push(parsed as TelemetryRecord);
		} catch {}
	}
	return limit === undefined ? records : records.slice(-limit);
}
