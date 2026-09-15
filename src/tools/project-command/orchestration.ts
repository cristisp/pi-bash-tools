export type ProjectCommandEvidenceScope = "session" | "flow";

export interface ProjectCommandOrchestrationContext {
  readonly flowId?: string;
  readonly delegationId?: string;
  readonly role?: string;
  readonly mode?: "initial" | "remediation";
  readonly configuredScope: ProjectCommandEvidenceScope;
  readonly effectiveScope: ProjectCommandEvidenceScope;
  readonly orchestrated: boolean;
}

import { FLOW_ID_PATTERN } from "../value-validation.ts";

const ORCHESTRATION_IDENTIFIER_PATTERN = FLOW_ID_PATTERN;

function boundedIdentifier(value: string | undefined): string | undefined {
  return value !== undefined && ORCHESTRATION_IDENTIFIER_PATTERN.test(value) ? value : undefined;
}

function scope(value: string | undefined): ProjectCommandEvidenceScope {
  return value === "flow" ? "flow" : "session";
}

export function readProjectCommandOrchestrationContext(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ProjectCommandOrchestrationContext {
  const flowId = boundedIdentifier(environment.PI_ORCHESTRATION_FLOW);
  const delegationId = boundedIdentifier(environment.PI_DELEGATION_ID);
  const role = boundedIdentifier(environment.PI_ORCHESTRATION_ROLE);
  const mode = environment.PI_ORCHESTRATION_MODE;
  const configuredScope = scope(environment.PI_ORCHESTRATION_EVIDENCE_SCOPE);
  const effectiveScope = configuredScope === "flow" && flowId !== undefined ? "flow" : "session";
  return {
    ...(flowId === undefined ? {} : { flowId }),
    ...(delegationId === undefined ? {} : { delegationId }),
    ...(role === undefined ? {} : { role }),
    ...(mode === "initial" || mode === "remediation" ? { mode } : {}),
    configuredScope,
    effectiveScope,
    orchestrated:
      flowId !== undefined ||
      delegationId !== undefined ||
      role !== undefined ||
      mode === "initial" ||
      mode === "remediation" ||
      environment.PI_ORCHESTRATION_EVIDENCE_SCOPE !== undefined,
  };
}

/** The flow identity a caller may attribute to itself, and only from its own environment. */
export function effectiveOrchestrationFlowId(
  orchestration: ProjectCommandOrchestrationContext,
): string | undefined {
  return orchestration.effectiveScope === "flow" ? orchestration.flowId : undefined;
}
