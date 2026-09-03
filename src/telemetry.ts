import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { withFileLock } from './registry-store.ts';
import { makeEmptyUsage } from './types.ts';
import type {
	DelegationContext,
	ExecutionMetrics,
	ReportSummary,
	SingleResult,
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
	if (typeof delegation.tier === 'number') record.tier = delegation.tier;
	if (delegation.workflowMode) record.workflowMode = delegation.workflowMode;
	if (delegation.reviewMode) record.reviewMode = delegation.reviewMode;
	if (delegation.acceptanceCriteria?.length)
		record.acceptanceCriteria = delegation.acceptanceCriteria;
	if (input.parentSession) record.parentSession = input.parentSession;
	if (result.model) record.childModel = result.model;
	if (result.stopReason) record.stopReason = result.stopReason;
	if (input.sessionFile) record.sessionFile = input.sessionFile;
	const report = input.report;
	if (report) {
		const summary: ReportSummary = {
			tokens: report.tokens,
			digestTokens: report.digestTokens,
			truncated: report.truncated,
			ledgerParsed: report.ledgerParsed,
		};
		if (report.path) summary.path = report.path;
		record.report = summary;
	}
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
