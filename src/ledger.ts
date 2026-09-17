import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfig } from './config.ts';
import { isOpaqueId } from './delegation.ts';
import { flowDirFor, readFlowManifest, writeFlowManifest } from './flow.ts';
import { withFileLock } from './registry-store.ts';
import type { DelegationContext } from './types.ts';

export const LEDGER_NAME = 'ledger.md';
const LEDGER_VERSION = 1;

/**
 * The ledger shape, stated once in code. `src/templates.ts` renders its instruction text from this
 * list and the digest parser validates against it, so the mandate and the check cannot drift.
 */
export const LEDGER_FIELDS = [
	'workflow_version',
	'task_id',
	'attempt',
	'workflow_tier',
	'workflow_mode',
	'review_mode',
	'delegation_status',
	'validation_verdict',
	'review_verdict',
	'session_strategy',
	'session_strategy_reason',
	'finding_scope',
	'acceptance_criteria',
	'scope',
	'out_of_scope',
	'evidence_refs',
	'invariants',
	'changed_files',
	'validation_refs',
	'validation_omitted',
	'evidence_recovery',
	'findings',
	'baseline_failures',
	'environment_blockers',
	'unresolved_questions',
	'transition_reason',
	'recommended_next_action',
	'budget',
];

/**
 * Child ledger fields the extension folds into the flow ledger. Anything richer stays in the report
 * file, because the ledger is read by every later child and must not grow into a report.
 */
export const LEDGER_FOLD_FIELDS = [
	'delegation_status',
	'validation_verdict',
	'review_verdict',
	'session_strategy',
	'finding_scope',
	'changed_files',
	'validation_refs',
	'validation_omitted',
	'evidence_recovery',
	'findings',
	'baseline_failures',
	'environment_blockers',
	'unresolved_questions',
	'recommended_next_action',
	'budget',
];

const VALUE_CHARS = 200;
const REVISION_MARKER = /^## revision (\d+)\b/gm;
const REVISION_SPLIT = /^## revision \d+\b/m;
const KEY_LINE = /^([a-z_]+):[ \t]*(.*)$/;

export interface LedgerPointer {
	path: string;
	revision: number;
}

export interface LedgerRevision {
	revision: number;
	fields: Record<string, string>;
}

export interface LedgerRevisionInput {
	flowId: string | undefined;
	kind: 'dispatch' | 'result';
	delegation: DelegationContext;
	label?: string;
	reused?: boolean;
	outcome?: 'settled' | 'failed' | 'aborted';
	exitCode?: number;
	toolCalls?: number;
	failedToolCalls?: number;
	turns?: number;
	reportPath?: string;
	/** Selected fields parsed out of the child's own ledger block. */
	childFields?: Record<string, string>;
}

export function ledgerPath(flowId: string): string {
	return path.join(flowDirFor(flowId), LEDGER_NAME);
}

/** The empty ledger the role prompts show children, generated from the same field list. */
export function ledgerShapeBlock(): string {
	const lines = LEDGER_FIELDS.map((field) =>
		field === 'workflow_version' ? `${field}: ${LEDGER_VERSION}` : `${field}:`,
	);
	return ['```text', ...lines, '```'].join('\n');
}

function oneLine(value: unknown): string {
	const raw = Array.isArray(value) ? value.join(',') : (value ?? '');
	const flat = String(raw).replace(/\s+/g, ' ').trim();
	return flat.length > VALUE_CHARS ? `${flat.slice(0, VALUE_CHARS)}...` : flat;
}

function headerText(): string {
	return [
		`# Orchestration ledger`,
		'',
		'Written by subagent-herdr at delegation boundaries. Append-only. Children read this file',
		'and never write it: status and verdict fields are set by the delegating session, not by the',
		'agent they describe. Full prose for any turn lives in the report path named below.',
		'',
	].join('\n');
}

function serializeRevision(revision: number, fields: Record<string, string>, at: Date): string {
	const kind = fields.kind ?? 'revision';
	const lines = ['```text', `workflow_version: ${LEDGER_VERSION}`, `revision: ${revision}`];
	for (const [key, value] of Object.entries(fields)) {
		if (key === 'workflow_version' || key === 'revision') continue;
		lines.push(`${key}: ${oneLine(value)}`);
	}
	lines.push('```');
	return [`## revision ${revision} - ${kind} - ${at.toISOString()}`, '', lines.join('\n'), ''].join(
		'\n',
	);
}

export function parseLedger(text: string): LedgerRevision[] {
	const revisions: LedgerRevision[] = [];
	const parts = text.split(REVISION_SPLIT);
	const numbers = [...text.matchAll(REVISION_MARKER)].map((match) => Number(match[1]));
	numbers.forEach((revision, index) => {
		const body = parts[index + 1] ?? '';
		const fields: Record<string, string> = {};
		for (const line of body.split('\n')) {
			const kv = KEY_LINE.exec(line.trim());
			if (kv) fields[kv[1] as string] = (kv[2] ?? '').trim();
		}
		// A header whose block never landed is a torn write; dropping it keeps the rewritten file clean.
		if (Object.keys(fields).length > 0) revisions.push({ revision, fields });
	});
	return revisions;
}

function readRevisions(flowId: string): LedgerRevision[] {
	try {
		return parseLedger(fs.readFileSync(ledgerPath(flowId), 'utf-8'));
	} catch {
		return [];
	}
}

function writeText(flowId: string, text: string): void {
	const target = ledgerPath(flowId);
	const tmp = `${target}.tmp`;
	fs.mkdirSync(flowDirFor(flowId), { recursive: true });
	try {
		// Read-only for its owner on purpose: a child with the write tool cannot append verdicts to
		// the ledger that describe itself, so D1 holds at the filesystem instead of in a prompt.
		fs.writeFileSync(tmp, text, { mode: 0o400 });
		fs.chmodSync(tmp, 0o400);
		fs.renameSync(tmp, target);
	} catch {
		try {
			fs.unlinkSync(tmp);
		} catch {}
	}
}

function revisionBlock(revision: LedgerRevision): string {
	return serializeRevision(
		revision.revision,
		revision.fields,
		new Date(revision.fields.at ?? Date.now()),
	);
}

/**
 * Appends one ledger revision and returns the resulting pointer, or `undefined` when the store is
 * unwritable. The ledger never blocks or fails a delegation: an unreadable flow simply has no ledger.
 */
export function appendLedgerRevision(input: LedgerRevisionInput): LedgerPointer | undefined {
	if (!isOpaqueId(input.flowId)) return undefined;
	const flowId = input.flowId;
	const at = new Date();
	try {
		return withFileLock(path.join(flowDirFor(flowId), '.lock'), () => {
			const existing = readRevisions(flowId);
			const manifest = readFlowManifest(flowId);
			// Numbering continues from the highest revision ever issued for this flow, so a truncated or
			// rewritten ledger cannot make one revision number mean two different things.
			const issued = Math.max(existing.at(-1)?.revision ?? 0, manifest?.lastLedgerRevision ?? 0);
			const revision = issued + 1;
			const fields: Record<string, string> = {
				kind: input.kind,
				at: at.toISOString(),
				role: input.delegation.role,
				scope: input.delegation.evidenceScope,
			};
			if (input.delegation.taskId) fields.task_id = input.delegation.taskId;
			if (input.kind === 'dispatch')
				fields.attempt = String(nextAttempt(existing, input.delegation.taskId));
			if (typeof input.delegation.tier === 'number')
				fields.workflow_tier = String(input.delegation.tier);
			if (input.delegation.workflowMode) fields.workflow_mode = input.delegation.workflowMode;
			if (input.delegation.reviewMode) fields.review_mode = input.delegation.reviewMode;
			if (input.delegation.acceptanceCriteria?.length)
				fields.acceptance_criteria = input.delegation.acceptanceCriteria.join(',');
			if (input.delegation.scope) {
				const scope = [
					...(input.delegation.scope.paths ?? []),
					...(input.delegation.scope.hunks ?? []),
				].join(',');
				if (scope) fields.finding_scope = scope;
				if (input.delegation.scope.outOfScope?.length)
					fields.out_of_scope = input.delegation.scope.outOfScope.join(',');
			}
			if (input.delegation.reviewSurfacePath)
				fields.evidence_refs = input.delegation.reviewSurfacePath;
			if (input.label) fields.label = input.label;
			if (input.reused !== undefined) fields.reused = String(input.reused);
			fields.delegation_id = input.delegation.delegationId;
			if (input.outcome) fields.outcome = input.outcome;
			if (typeof input.exitCode === 'number' && input.exitCode !== 0)
				fields.exit_code = String(input.exitCode);
			if (typeof input.toolCalls === 'number') fields.tool_calls = String(input.toolCalls);
			if (typeof input.failedToolCalls === 'number' && input.failedToolCalls > 0)
				fields.failed_tool_calls = String(input.failedToolCalls);
			if (typeof input.turns === 'number') fields.turns = String(input.turns);
			if (input.reportPath) fields.report = input.reportPath;
			if (input.childFields) {
				for (const field of LEDGER_FOLD_FIELDS) {
					const value = input.childFields[field];
					if (value) fields[field] = value;
				}
			}

			const appended = [...existing, { revision, fields }];
			const keep = appended.slice(-Math.max(1, getConfig().ledgerMaxRevisions));
			const text = headerText() + keep.map((entry) => revisionBlock(entry)).join('\n');
			writeText(flowId, text);
			if (manifest) {
				writeFlowManifest(flowId, {
					...manifest,
					lastUsedAt: Date.now(),
					lastLedgerRevision: revision,
				});
			}
			return { path: ledgerPath(flowId), revision };
		});
	} catch {
		return undefined;
	}
}

/** Attempts are counted from the ledger itself, so the number cannot drift from what actually ran. */
export function nextAttempt(existing: LedgerRevision[], taskId?: string): number {
	if (!taskId) return 1;
	return (
		existing.filter((entry) => entry.fields.kind === 'dispatch' && entry.fields.task_id === taskId)
			.length + 1
	);
}

export function ledgerPointer(flowId: string | undefined): LedgerPointer | undefined {
	if (!isOpaqueId(flowId)) return undefined;
	const revisions = readRevisions(flowId);
	const head = revisions.at(-1);
	if (!head) return undefined;
	return { path: ledgerPath(flowId), revision: head.revision };
}

/** Prompt text for a fresh launch: the pointer only, never the ledger body. */
export function ledgerPrefixBlock(pointer: LedgerPointer): string {
	return [
		'## Orchestration ledger',
		'',
		`Path: ${pointer.path}`,
		`Revision: ${pointer.revision}`,
		'',
		'The current task, acceptance criteria, tier, evidence scope and prior verdicts for this flow',
		'live in that file, newest revision last. Normal handoffs carry a compact current context below;',
		'do not preload the historical ledger before discovery. Use the read tool only for the bounded paths needed for a',
		'named stale, rejected, ambiguous, or otherwise required evidence gap (or an explicit audit,',
		'integration, or recovery request). Never write to it: emit your own ledger block in your reply',
		'and the delegating session folds it in.',
	].join('\n');
}

/** Prompt text for a reuse turn, whose system prompt was frozen at launch. */
export function ledgerTurnLine(pointer: LedgerPointer): string {
	return `ledger: ${pointer.path}@${pointer.revision} (refreshed turn pointer; use bounded recovery only for a named stale, rejected, ambiguous, or required evidence gap)`;
}
