import {
  createToolErrorContract,
  suggestedActionForCategory,
  withToolErrorContract,
  type ToolErrorContract,
} from "../../errors.ts";
import { getProjectCommandDefinitions, type ProjectCommandDefinition } from "../definitions.ts";
import { normalizeBooleanInput } from "../../boolean.ts";
import { projectCommandIdGuidance } from "../command-id-guidance.ts";
import { validateNodeTestPaths, validateProjectCommandRevision } from "../parameters.ts";
import {
  isValidNodePackageScriptVariant,
  nodePackageScriptVariantKey,
} from "../node/package-script.ts";
import type {
  ProjectCommandEvidenceLookup,
  ProjectCommandInput,
  ProjectCommandInputFor,
} from "../schema.ts";

function defaultErrorContract(message: string): ToolErrorContract {
  return createToolErrorContract({
    code: "project-command-error",
    category: "IMPLEMENTATION_FAILURE",
    explanation: message,
    suggestedAction: suggestedActionForCategory("IMPLEMENTATION_FAILURE"),
    retryable: false,
    executed: false,
  });
}

export class ProjectCommandToolError extends Error {
  readonly details: unknown;
  readonly contract: ToolErrorContract;

  constructor(message: string, details?: unknown, contract?: ToolErrorContract) {
    super(message);
    this.name = "ProjectCommandToolError";
    this.contract = contract ?? defaultErrorContract(message);
    this.details =
      details === undefined
        ? withToolErrorContract({}, this.contract)
        : isRecord(details)
          ? withToolErrorContract(details, this.contract)
          : details;
  }
}

type InvalidRequestDetails = object & {
  readonly remediation?: unknown;
  readonly correctedExample?: unknown;
};

export function invalidRequest(
  invalidField?: string,
  details: InvalidRequestDetails = {},
): ProjectCommandToolError {
  const remediation =
    typeof details.remediation === "string"
      ? details.remediation
      : invalidField === undefined
        ? "Provide a request matching one of the supported project command shapes and retry."
        : `Correct the ${invalidField} field and retry the command.`;
  const contract = createToolErrorContract({
    code: "invalid-request",
    category: "INVALID_REQUEST",
    explanation: "The project command request does not match the supported command schema.",
    ...(invalidField === undefined ? {} : { invalidField }),
    ...(details.correctedExample === undefined
      ? {}
      : { correctedExample: details.correctedExample }),
    suggestedAction: suggestedActionForCategory("INVALID_REQUEST"),
    retryable: false,
    executed: false,
  });
  return new ProjectCommandToolError(
    `Project command request is invalid; action: ${remediation}`,
    withToolErrorContract(details, contract),
    contract,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonStringArray(value: unknown, field: string): readonly string[] | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  } catch {
    // Fall through to the actionable error.
  }
  throw invalidRequest(field, {
    remediation: `Provide ${field} as an array or an unambiguous JSON array string and retry.`,
    correctedExample: { commandId: "node_test", [field]: `["src/index.ts"]` },
  });
}

function validateEvidenceIdentifier(
  value: unknown,
  field: string,
  pattern: RegExp,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !pattern.test(value)) {
    throw invalidRequest(field, {
      remediation: `Provide ${field} with the expected bounded identifier shape and retry.`,
      correctedExample: field === "ref" ? { ref: "pc_example" } : { flowId: "flow-1" },
    });
  }
  return value;
}

function validateEvidenceCovers(value: unknown, commandId: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    !value.every(
      (cover): cover is string =>
        typeof cover === "string" && cover.length > 0 && cover.length <= 512,
    )
  ) {
    throw invalidRequest("covers", {
      correctedExample: { commandId, covers: ["AC-001"] },
    });
  }
  return value;
}

function validateNodeScriptVariant(
  value: unknown,
  family: "test" | "lint" | "format",
  required = false,
): string | undefined {
  if (value === undefined) {
    if (required) throw invalidRequest("variant");
    return undefined;
  }
  if (
    !isValidNodePackageScriptVariant(value) ||
    nodePackageScriptVariantKey(family, value) === undefined
  ) {
    throw invalidRequest("variant");
  }
  return value;
}

function legacyVariantForCommandId(
  commandId: string,
  definitions: readonly ProjectCommandDefinition[],
): { readonly commandId: string; readonly variant: string } | undefined {
  const match = /^(node_test|node_lint|node_format):(.+)$/u.exec(commandId);
  const base = match?.[1];
  const variant = match?.[2];
  if (
    base === undefined ||
    variant === undefined ||
    !definitions.some((definition) => definition.commandId === base)
  ) {
    return undefined;
  }
  return { commandId: base, variant };
}

function findDefinition(
  commandId: string,
  definitions: readonly ProjectCommandDefinition[],
): ProjectCommandDefinition {
  const matches = definitions.filter((definition) => definition.commandId === commandId);
  if (matches.length !== 1) {
    const guidance = projectCommandIdGuidance(commandId, definitions);
    throw invalidRequest("commandId", guidance);
  }
  const definition = matches[0];
  if (definition === undefined) {
    const guidance = projectCommandIdGuidance(commandId, definitions);
    throw invalidRequest("commandId", guidance);
  }
  return definition;
}

function validateRequestKeys(keys: readonly string[], commandId: string): void {
  const evidenceKeys = ["publish", "covers"];
  const expectedKeys =
    commandId === "node_test"
      ? ["commandId", "force", "paths", "variant", ...evidenceKeys]
      : commandId === "fallow_audit"
        ? ["commandId", "force", "base", ...evidenceKeys]
        : commandId === "node_lint" || commandId === "node_format"
          ? ["commandId", "force", "variant", ...evidenceKeys]
          : ["commandId", "force", ...evidenceKeys];
  const invalidKey = keys.find((key) => !expectedKeys.includes(key));
  if (!keys.includes("commandId") || invalidKey !== undefined) {
    throw invalidRequest(invalidKey ?? "commandId", {
      correctedExample: { commandId },
    });
  }
}

export type NormalizedProjectCommandInput =
  | {
      readonly commandId: string;
      readonly force?: boolean;
      readonly paths?: readonly string[];
      readonly base?: string;
      readonly variant?: string;
      readonly ref?: string;
      readonly flowId?: string;
      readonly publish?: { readonly flowId: string };
      readonly covers?: readonly string[];
      readonly coercions?: readonly string[];
    }
  | ProjectCommandEvidenceLookup;

function normalizedRequest(
  params: Record<string, unknown>,
  commandId: string,
  coercions: string[],
): NormalizedProjectCommandInput {
  const covers = validateEvidenceCovers(params.covers, commandId);
  const ref = validateEvidenceIdentifier(params.ref, "ref", /^[A-Za-z0-9_-]{8,128}$/u);
  const flowId = validateEvidenceIdentifier(params.flowId, "flowId", /^[A-Za-z0-9_-]{1,64}$/u);
  const publishValue = params.publish;
  let publish: { readonly flowId: string } | undefined;
  if (publishValue !== undefined) {
    if (
      !isRecord(publishValue) ||
      typeof publishValue.flowId !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/u.test(publishValue.flowId) ||
      Object.keys(publishValue).some((key) => key !== "flowId")
    ) {
      throw invalidRequest("publish", {
        correctedExample: { commandId, publish: { flowId: "flow-1" } },
      });
    }
    publish = { flowId: publishValue.flowId };
  }
  if (ref !== undefined && (publish !== undefined || commandId !== "")) {
    throw invalidRequest("ref", {
      remediation:
        "Use ref with optional flowId and covers only; do not include execution options.",
      correctedExample: { ref: "pc_example", flowId: "flow-1" },
    });
  }
  if (flowId !== undefined && ref === undefined) {
    throw invalidRequest("flowId", {
      remediation: "flowId is lookup-only and requires ref.",
      correctedExample: { ref: "pc_example", flowId: "flow-1" },
    });
  }
  const evidence = {
    ...(ref === undefined ? {} : { ref }),
    ...(flowId === undefined ? {} : { flowId }),
    ...(publish === undefined ? {} : { publish }),
    ...(covers === undefined ? {} : { covers }),
    ...(coercions.length === 0 ? {} : { coercions: [...coercions] }),
  };
  if (commandId === "") {
    if (ref === undefined) throw invalidRequest("ref");
    return {
      ref,
      ...(flowId === undefined ? {} : { flowId }),
      ...(covers === undefined ? {} : { covers }),
    } satisfies ProjectCommandEvidenceLookup;
  }
  if (commandId === "fallow_audit") {
    try {
      return { commandId, base: validateProjectCommandRevision(params.base), ...evidence };
    } catch {
      throw invalidRequest("base");
    }
  }
  if (commandId === "node_test") {
    try {
      const variant = validateNodeScriptVariant(params.variant, "test");
      const parsedPaths = parseJsonStringArray(params.paths, "paths");
      if (parsedPaths !== undefined) coercions.push("paths:string-json-array");
      const paths = validateNodeTestPaths(parsedPaths ?? params.paths);
      const base = paths.length === 0 ? { commandId } : { commandId, paths };
      return variant === undefined
        ? {
            ...base,
            ...evidence,
            ...(coercions.length === 0 ? {} : { coercions: [...coercions] }),
          }
        : {
            ...base,
            variant,
            ...evidence,
            ...(coercions.length === 0 ? {} : { coercions: [...coercions] }),
          };
    } catch (error) {
      if (error instanceof ProjectCommandToolError) throw error;
      throw invalidRequest("paths");
    }
  }
  if (commandId === "node_lint") {
    try {
      const variant = validateNodeScriptVariant(params.variant, "lint");
      return variant === undefined
        ? { commandId, ...evidence }
        : { commandId, variant, ...evidence };
    } catch (error) {
      if (error instanceof ProjectCommandToolError) throw error;
      throw invalidRequest("variant");
    }
  }
  if (commandId === "node_format") {
    try {
      const variant = validateNodeScriptVariant(params.variant, "format");
      return variant === undefined
        ? { commandId, ...evidence }
        : { commandId, variant, ...evidence };
    } catch (error) {
      if (error instanceof ProjectCommandToolError) throw error;
      throw invalidRequest("variant");
    }
  }
  return { commandId, ...evidence };
}

export function validateProjectCommandInput(params: unknown): ProjectCommandInput;
export function validateProjectCommandInput<
  const Definitions extends readonly ProjectCommandDefinition[],
>(params: unknown, definitions: Definitions): ProjectCommandInputFor<Definitions>;
export function validateProjectCommandInput(
  params: unknown,
  definitions: readonly ProjectCommandDefinition[] = getProjectCommandDefinitions(),
): NormalizedProjectCommandInput {
  try {
    if (!isRecord(params)) {
      throw invalidRequest(undefined, projectCommandIdGuidance("", definitions));
    }
    const request = params;
    const coercions: string[] = [];
    if ("ref" in request) {
      const lookupKeys = ["ref", "flowId", "covers"];
      const invalidLookupKey = Object.keys(request).find((key) => !lookupKeys.includes(key));
      if (invalidLookupKey !== undefined) {
        throw invalidRequest(invalidLookupKey, {
          remediation: "Lookup requests accept only ref, optional flowId, and covers.",
          correctedExample: { ref: "pc_example", flowId: "flow-1" },
        });
      }
      return normalizedRequest(request, "", coercions);
    }
    const requestedCommandId = request.commandId;
    if (typeof requestedCommandId !== "string") {
      throw invalidRequest("commandId", projectCommandIdGuidance("", definitions));
    }
    const legacyVariant = legacyVariantForCommandId(requestedCommandId, definitions);
    const commandId = legacyVariant?.commandId ?? requestedCommandId;
    if (legacyVariant !== undefined && "variant" in request) {
      throw invalidRequest("variant");
    }
    findDefinition(commandId, definitions);
    validateRequestKeys(Object.keys(request), commandId);
    let force: boolean | undefined;
    try {
      force = normalizeBooleanInput(request.force, "force");
    } catch {
      throw invalidRequest("force");
    }
    const normalized = normalizedRequest(
      legacyVariant === undefined ? request : { ...request, variant: legacyVariant.variant },
      commandId,
      coercions,
    );
    return force === true ? { ...normalized, force: true } : normalized;
  } catch (error) {
    if (error instanceof ProjectCommandToolError) {
      throw error;
    }
    throw invalidRequest();
  }
}

export function cancellationError(details?: unknown): ProjectCommandToolError {
  const executed =
    typeof details === "object" && details !== null && "executed" in details
      ? details.executed === true
      : false;
  const contract = createToolErrorContract({
    code: "cancelled",
    category: "CANCELLED",
    explanation: "The project command request was cancelled.",
    suggestedAction: suggestedActionForCategory("CANCELLED"),
    retryable: true,
    executed,
  });
  const error = new ProjectCommandToolError(
    "Project command request cancelled",
    isRecord(details)
      ? withToolErrorContract(details, contract)
      : withToolErrorContract({}, contract),
    contract,
  );
  error.name = "AbortError";
  return error;
}
