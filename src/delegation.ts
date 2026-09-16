import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { getConfig } from './config.ts';
import type {
	DelegationContext,
	EvidenceScope,
	OrchestrationContext,
	RegistryEntry,
	ReviewScope,
} from './types.ts';

export const ENV_FLOW = 'PI_ORCHESTRATION_FLOW';
export const ENV_DELEGATION = 'PI_DELEGATION_ID';
export const ENV_ROLE = 'PI_ORCHESTRATION_ROLE';
export const ENV_TIER = 'PI_ORCHESTRATION_TIER';
export const ENV_MODE = 'PI_ORCHESTRATION_MODE';
export const ENV_TASK = 'PI_ORCHESTRATION_TASK';
export const ENV_REVIEW_MODE = 'PI_ORCHESTRATION_REVIEW_MODE';
export const ENV_CRITERIA = 'PI_ORCHESTRATION_CRITERIA';
export const ENV_EVIDENCE_SCOPE = 'PI_ORCHESTRATION_EVIDENCE_SCOPE';
export const ENV_ROOT_SESSION = 'PI_ORCHESTRATION_ROOT_SESSION';
export const ENV_PARENT_PANE = 'PI_ORCHESTRATION_PARENT_PANE';
/** Number of paths declared in the delegation scope; sizes the inspection budget of the child. */
export const ENV_SCOPE_PATHS = 'PI_ORCHESTRATION_SCOPE_PATHS';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CRITERION_PATTERN = /^[A-Za-z0-9._:-]{1,32}$/;
const MAX_CRITERIA = 64;
const MAX_SCOPE_ITEMS = 100;
const MAX_SCOPE_ITEM_LENGTH = 512;

/** Only the two scope knobs are needed to resolve identity. */
export interface EvidenceScopePolicy {
	evidenceScopeDefault: EvidenceScope;
	evidenceScopeByRole: Record<string, EvidenceScope>;
}

export function isOpaqueId(value: unknown): value is string {
	return typeof value === 'string' && ID_PATTERN.test(value);
}

/**
 * Flow id for a delegation: stable for one root session, shared by every child
 * it spawns, and never reused across sessions.
 */
export function deriveFlowId(parentSession: string | undefined): string | undefined {
	if (!parentSession) return undefined;
	return `f${createHash('sha256').update(parentSession).digest('hex').slice(0, 16)}`;
}

export function newDelegationId(): string {
	return randomUUID();
}

export function evidenceScopeForRole(
	role: string,
	policy?: Partial<EvidenceScopePolicy>,
): EvidenceScope {
	const byRole = policy?.evidenceScopeByRole;
	if (byRole && Object.hasOwn(byRole, role)) {
		const scoped = byRole[role];
		if (scoped === 'session' || scoped === 'flow') return scoped;
	}
	const fallback = policy?.evidenceScopeDefault;
	return fallback === 'session' || fallback === 'flow' ? fallback : 'flow';
}

/** A caller may narrow the configured scope; widening attempts are ignored. */
export function narrowEvidenceScope(
	configured: EvidenceScope,
	requested?: EvidenceScope,
): EvidenceScope {
	if (!requested || requested === configured) return configured;
	return configured === 'flow' && requested === 'session' ? 'session' : configured;
}

export function sanitizeCriteria(criteria: readonly string[]): string[] {
	return criteria
		.filter((criterion) => CRITERION_PATTERN.test(criterion))
		.filter((criterion, index, all) => all.indexOf(criterion) === index)
		.slice(0, MAX_CRITERIA);
}

/** Task ids share the criterion alphabet so both survive env, shell quoting and grep. */
export function sanitizeTaskId(taskId: unknown): string | undefined {
	return typeof taskId === 'string' && CRITERION_PATTERN.test(taskId) ? taskId : undefined;
}

function canonicalScopeItem(item: string): string | undefined {
	const normalized = item.trim().replaceAll('\\', '/');
	const hasControlCharacter = Array.from(normalized).some((character) => {
		const code = character.codePointAt(0) ?? 0;
		return code <= 0x1f || code === 0x7f;
	});
	if (!normalized || normalized.length > MAX_SCOPE_ITEM_LENGTH || hasControlCharacter)
		return undefined;
	if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return undefined;
	const segments = normalized.split('/').filter((segment) => segment.length > 0 && segment !== '.');
	if (segments.length === 0 || segments.some((segment) => segment === '..')) return undefined;
	return segments.join('/');
}

function scopeItems(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value
		.filter((item): item is string => typeof item === 'string')
		.map(canonicalScopeItem)
		.filter((item): item is string => item !== undefined)
		.filter((item, index, all) => all.indexOf(item) === index)
		.slice(0, MAX_SCOPE_ITEMS);
	return items.length > 0 ? items : undefined;
}

function validReviewSurfacePath(flowId: string | undefined, value: unknown): value is string {
	if (!flowId || typeof value !== 'string') return false;
	return (
		path.resolve(value) ===
		path.join(getAgentDir(), 'subagent-herdr', 'flows', flowId, 'predigest', 'review-surface.md')
	);
}

export function sanitizeReviewScope(scope: unknown): ReviewScope | undefined {
	if (!scope || typeof scope !== 'object') return undefined;
	const value = scope as Record<string, unknown>;
	const sanitized: ReviewScope = {};
	const paths = scopeItems(value.paths);
	const hunks = scopeItems(value.hunks);
	const outOfScope = scopeItems(value.outOfScope);
	if (paths) sanitized.paths = paths;
	if (hunks) sanitized.hunks = hunks;
	if (outOfScope) sanitized.outOfScope = outOfScope;
	return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function resolveDelegation(options: {
	role: string;
	policy?: Partial<EvidenceScopePolicy>;
	parentSession?: string;
	orchestration?: OrchestrationContext;
	delegationId?: string;
	flowId?: string;
	rootSession?: string;
	parentPaneId?: string;
}): DelegationContext {
	const orchestration = options.orchestration ?? {};
	const flowId = isOpaqueId(options.flowId) ? options.flowId : deriveFlowId(options.parentSession);
	const delegation: DelegationContext = {
		delegationId: isOpaqueId(options.delegationId) ? options.delegationId : newDelegationId(),
		role: options.role,
		...((options.rootSession ?? options.parentSession)
			? { rootSession: options.rootSession ?? options.parentSession }
			: {}),
		...(options.parentPaneId ? { parentPaneId: options.parentPaneId } : {}),
		evidenceScope: narrowEvidenceScope(
			evidenceScopeForRole(options.role, options.policy),
			orchestration.evidenceScope,
		),
	};
	if (flowId) delegation.flowId = flowId;
	const taskId = sanitizeTaskId(orchestration.taskId);
	if (taskId) delegation.taskId = taskId;
	if (typeof orchestration.tier === 'number') delegation.tier = orchestration.tier;
	if (orchestration.workflowMode) delegation.workflowMode = orchestration.workflowMode;
	if (orchestration.reviewMode) delegation.reviewMode = orchestration.reviewMode;
	// Always record the effective policy, even when the caller did not supply an override.
	delegation.compositionPolicy = orchestration.compositionPolicy ?? getConfig().compositionPolicy;
	if (orchestration.compositionPolicyOverride)
		delegation.compositionPolicyOverride = orchestration.compositionPolicyOverride;
	if (orchestration.compositionVerdicts?.length)
		delegation.compositionVerdicts = orchestration.compositionVerdicts;
	if (orchestration.acceptanceCriteria?.length)
		delegation.acceptanceCriteria = sanitizeCriteria(orchestration.acceptanceCriteria);
	const scope = sanitizeReviewScope(orchestration.scope);
	if (scope) delegation.scope = scope;
	if (isOpaqueId(orchestration.compositionBoundaryId))
		delegation.compositionBoundaryId = orchestration.compositionBoundaryId;
	if (validReviewSurfacePath(flowId, orchestration.reviewSurfacePath))
		delegation.reviewSurfacePath = orchestration.reviewSurfacePath;
	const reviewSurfaceRevision = orchestration.reviewSurfaceRevision;
	if (
		typeof reviewSurfaceRevision === 'number' &&
		Number.isSafeInteger(reviewSurfaceRevision) &&
		reviewSurfaceRevision > 0
	)
		delegation.reviewSurfaceRevision = reviewSurfaceRevision;
	if (orchestration.reviewSurfaceRefreshed !== undefined)
		delegation.reviewSurfaceRefreshed = orchestration.reviewSurfaceRefreshed;
	if (orchestration.dirtyPaths?.length) delegation.dirtyPaths = [...orchestration.dirtyPaths];
	return delegation;
}

export function orchestrationFromEntry(entry: RegistryEntry): OrchestrationContext {
	const orchestration: OrchestrationContext = {};
	if (typeof entry.tier === 'number') orchestration.tier = entry.tier;
	if (entry.workflowMode) orchestration.workflowMode = entry.workflowMode;
	if (entry.reviewMode) orchestration.reviewMode = entry.reviewMode;
	if (entry.acceptanceCriteria?.length) orchestration.acceptanceCriteria = entry.acceptanceCriteria;
	if (entry.evidenceScope) orchestration.evidenceScope = entry.evidenceScope;
	if (entry.scope) orchestration.scope = entry.scope;
	if (entry.reviewSurfacePath) orchestration.reviewSurfacePath = entry.reviewSurfacePath;
	if (entry.reviewSurfaceRevision !== undefined)
		orchestration.reviewSurfaceRevision = entry.reviewSurfaceRevision;
	if (entry.reviewSurfaceRefreshed !== undefined)
		orchestration.reviewSurfaceRefreshed = entry.reviewSurfaceRefreshed;
	if (entry.dirtyPaths?.length) orchestration.dirtyPaths = [...entry.dirtyPaths];
	const taskId = sanitizeTaskId(entry.taskId);
	if (taskId) orchestration.taskId = taskId;
	return orchestration;
}

/**
 * Identity for a reuse turn: the delegation id and flow are inherited, and the
 * scope already resolved for this session is the ceiling a new turn may narrow.
 */
export function delegationFromEntry(
	entry: RegistryEntry,
	options: {
		policy?: Partial<EvidenceScopePolicy>;
		orchestration?: OrchestrationContext;
		rootSession?: string;
		parentPaneId?: string;
	} = {},
): DelegationContext {
	const policy: Partial<EvidenceScopePolicy> = {
		evidenceScopeDefault: entry.evidenceScope ?? options.policy?.evidenceScopeDefault ?? 'flow',
		evidenceScopeByRole: {},
	};
	return resolveDelegation({
		role: entry.agent,
		policy,
		parentSession: entry.parentSession,
		delegationId: entry.delegationId,
		flowId: entry.flowId,
		orchestration: { ...orchestrationFromEntry(entry), ...options.orchestration },
		rootSession: options.rootSession ?? entry.rootSession ?? entry.parentSession,
		parentPaneId: options.parentPaneId ?? entry.parentPaneId,
	});
}

/** Environment the child receives; absence of these names must mean "unowned". */
export function orchestrationEnv(delegation: DelegationContext): Record<string, string> {
	const env: Record<string, string> = {
		[ENV_DELEGATION]: delegation.delegationId,
		[ENV_ROLE]: delegation.role,
		[ENV_EVIDENCE_SCOPE]: delegation.evidenceScope,
	};
	if (delegation.flowId) env[ENV_FLOW] = delegation.flowId;
	if (typeof delegation.tier === 'number') env[ENV_TIER] = String(delegation.tier);
	if (delegation.workflowMode) env[ENV_MODE] = delegation.workflowMode;
	if (delegation.reviewMode) env[ENV_REVIEW_MODE] = delegation.reviewMode;
	if (delegation.acceptanceCriteria?.length)
		env[ENV_CRITERIA] = delegation.acceptanceCriteria.join(',');
	if (delegation.taskId) env[ENV_TASK] = delegation.taskId;
	if (delegation.scope?.paths?.length) env[ENV_SCOPE_PATHS] = String(delegation.scope.paths.length);
	if (delegation.rootSession) env[ENV_ROOT_SESSION] = delegation.rootSession;
	if (delegation.parentPaneId) env[ENV_PARENT_PANE] = delegation.parentPaneId;
	return env;
}
