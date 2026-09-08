import { hashCanonicalJson } from "../../observability/canonical-json.ts";
import { EXTENSION_VERSION } from "../../version.ts";
import type { LoadedPolicy } from "../policy/types.ts";
import {
  canonicalProjectCommandRelevantInputs,
  type ProjectCommandRelevantInputs,
} from "./relevant-inputs.ts";

export const PROJECT_COMMAND_RESULT_FINGERPRINT_VERSION = 1 as const;

export interface ProjectCommandLogicalRequestKeyInput {
  readonly authFingerprint: string;
  readonly projectPath: string;
  readonly effectiveParameters: Readonly<Record<string, unknown>>;
  readonly processTimeoutMs: number;
  readonly outputLimitBytes: number;
  readonly policyId: string;
  readonly reusePolicyId: string;
}

export interface ProjectCommandResultFingerprintInput extends ProjectCommandLogicalRequestKeyInput {
  readonly relevantInputs: ProjectCommandRelevantInputs;
  readonly stateDigest: string;
}

export interface ProjectCommandResultFingerprint {
  readonly version: typeof PROJECT_COMMAND_RESULT_FINGERPRINT_VERSION;
  readonly fingerprint: string;
  readonly policyId: string;
  readonly reusePolicyId: string;
  readonly relevantInputs: ProjectCommandRelevantInputs;
}

function logicalRequestPayload(
  input: ProjectCommandLogicalRequestKeyInput,
): Readonly<Record<string, unknown>> {
  return {
    resultFingerprintVersion: PROJECT_COMMAND_RESULT_FINGERPRINT_VERSION,
    extensionVersion: EXTENSION_VERSION,
    authFingerprint: input.authFingerprint,
    projectPath: input.projectPath,
    effectiveParameters: input.effectiveParameters,
    processTimeoutMs: input.processTimeoutMs,
    outputLimitBytes: input.outputLimitBytes,
    policyId: input.policyId,
    reusePolicyId: input.reusePolicyId,
  };
}

function fingerprintPayload(
  input: ProjectCommandResultFingerprintInput,
): Readonly<Record<string, unknown>> {
  return {
    ...logicalRequestPayload(input),
    stateDigest: input.stateDigest,
    relevantInputManifest: canonicalProjectCommandRelevantInputs(
      input.relevantInputs.files,
      input.relevantInputs.values,
    ),
  };
}

export function projectCommandPolicyId(policy: LoadedPolicy): string {
  return hashCanonicalJson({
    policyIdVersion: 1,
    document: policy.document,
  });
}

export function createProjectCommandLogicalRequestKey(
  input: ProjectCommandLogicalRequestKeyInput,
): string {
  return hashCanonicalJson(logicalRequestPayload(input));
}

export function createProjectCommandResultFingerprint(
  input: ProjectCommandResultFingerprintInput,
): ProjectCommandResultFingerprint {
  const relevantInputs = canonicalProjectCommandRelevantInputs(
    input.relevantInputs.files,
    input.relevantInputs.values,
  );
  const payload = fingerprintPayload({ ...input, relevantInputs });
  return Object.freeze({
    version: PROJECT_COMMAND_RESULT_FINGERPRINT_VERSION,
    fingerprint: hashCanonicalJson(payload),
    policyId: input.policyId,
    reusePolicyId: input.reusePolicyId,
    relevantInputs,
  });
}
