import { hashCanonicalJson } from "../../observability/canonical-json.ts";
import type { ProjectCommandOutputDetails } from "./output.ts";

export interface ProjectCommandEvidenceProvenance {
  readonly scope: "session" | "flow";
  readonly flowId?: string;
  readonly producerInvocationId?: string;
  readonly producerSessionId?: string;
  readonly producerRole?: string;
  readonly producerDelegationId?: string;
}

function evidenceDigest(value: unknown): string {
  try {
    return hashCanonicalJson(value);
  } catch {
    return hashCanonicalJson({ type: typeof value });
  }
}

/**
 * Deterministic audit identifier for one executed command result. The
 * identifier is derived from the result itself, so it needs no store: nothing
 * resolves it, but error details, invocation records, and analyzer streams
 * can still attribute executions across sessions.
 */
export function projectCommandEvidenceRef(
  details: Pick<
    ProjectCommandOutputDetails,
    "commandId" | "projectPath" | "parameters" | "status" | "category" | "stdout" | "stderr"
  >,
): string {
  const digest = evidenceDigest({
    commandId: details.commandId,
    projectPath: details.projectPath,
    parameters: details.parameters,
    status: details.status,
    category: details.category,
    stdout: details.stdout,
    stderr: details.stderr,
  });
  return `pc_${digest.slice(0, 24)}`;
}
