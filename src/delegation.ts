import { createHash, randomUUID } from 'node:crypto';
import type {
	DelegationContext,
	EvidenceScope,
	OrchestrationContext,
	RegistryEntry,
} from './types.ts';

export const ENV_FLOW = 'PI_ORCHESTRATION_FLOW';
export const ENV_DELEGATION = 'PI_DELEGATION_ID';
export const ENV_ROLE = 'PI_ORCHESTRATION_ROLE';
export const ENV_TIER = 'PI_ORCHESTRATION_TIER';
export const ENV_MODE = 'PI_ORCHESTRATION_MODE';
export const ENV_REVIEW_MODE = 'PI_ORCHESTRATION_REVIEW_MODE';
export const ENV_CRITERIA = 'PI_ORCHESTRATION_CRITERIA';
export const ENV_EVIDENCE_SCOPE = 'PI_ORCHESTRATION_EVIDENCE_SCOPE';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CRITERION_PATTERN = /^[A-Za-z0-9._:-]{1,32}$/;
const MAX_CRITERIA = 64;

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

export function resolveDelegation(options: {
	role: string;
	policy?: Partial<EvidenceScopePolicy>;
	parentSession?: string;
	orchestration?: OrchestrationContext;
	delegationId?: string;
	flowId?: string;
}): DelegationContext {
	const orchestration = options.orchestration ?? {};
	const flowId = isOpaqueId(options.flowId) ? options.flowId : deriveFlowId(options.parentSession);
	const delegation: DelegationContext = {
		delegationId: isOpaqueId(options.delegationId) ? options.delegationId : newDelegationId(),
		role: options.role,
		evidenceScope: narrowEvidenceScope(
			evidenceScopeForRole(options.role, options.policy),
			orchestration.evidenceScope,
		),
	};
	if (flowId) delegation.flowId = flowId;
	if (typeof orchestration.tier === 'number') delegation.tier = orchestration.tier;
	if (orchestration.workflowMode) delegation.workflowMode = orchestration.workflowMode;
	if (orchestration.reviewMode) delegation.reviewMode = orchestration.reviewMode;
	if (orchestration.acceptanceCriteria?.length)
		delegation.acceptanceCriteria = sanitizeCriteria(orchestration.acceptanceCriteria);
	return delegation;
}

export function orchestrationFromEntry(entry: RegistryEntry): OrchestrationContext {
	const orchestration: OrchestrationContext = {};
	if (typeof entry.tier === 'number') orchestration.tier = entry.tier;
	if (entry.workflowMode) orchestration.workflowMode = entry.workflowMode;
	if (entry.reviewMode) orchestration.reviewMode = entry.reviewMode;
	if (entry.acceptanceCriteria?.length) orchestration.acceptanceCriteria = entry.acceptanceCriteria;
	if (entry.evidenceScope) orchestration.evidenceScope = entry.evidenceScope;
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
	return env;
}
