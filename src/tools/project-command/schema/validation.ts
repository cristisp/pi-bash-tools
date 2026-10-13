import { normalizeBooleanInput } from "../../boolean.ts";
import {
  createToolErrorContract,
  suggestedActionForCategory,
  withToolErrorContract,
  type ToolErrorContract,
} from "../../errors.ts";
import { isRecord } from "../../value-validation.ts";
import { projectCommandIdGuidance } from "../command-id-guidance.ts";
import { getProjectCommandDefinitions, type ProjectCommandDefinition } from "../definitions.ts";
import { boundedEvidenceRefSegment } from "../diagnostics.ts";
import {
  isValidNodePackageScriptVariant,
  nodePackageScriptVariantKey,
} from "../node/package-script.ts";
import {
  PROJECT_COMMAND_MAX_PARAMETER_ITEMS,
  validateNodeTestPaths,
  validateProjectCommandRevision,
} from "../parameters.ts";
import type { ProjectCommandInput, ProjectCommandInputFor } from "../schema.ts";

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
    const contractDetails = isRecord(details) ? details : {};
    this.details = Object.freeze({
      ...withToolErrorContract(contractDetails, this.contract),
      resultCategory: this.contract.category,
      retryable: this.contract.retryable,
      ...(isRecord(details) && typeof details.diagnostic === "string"
        ? {}
        : { diagnostic: this.contract.explanation }),
      ...(details !== undefined && !isRecord(details) ? { detail: details } : {}),
    });
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

const NULL_TO_ABSENT_SUFFIX = "null-to-absent";

export function stripNullProperties(
  params: Readonly<Record<string, unknown>>,
  coercions: string[],
  strippableKeys: ReadonlySet<string>,
): Readonly<Record<string, unknown>> {
  let stripped: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(params)) {
    if (value === null && strippableKeys.has(key)) {
      coercions.push(`${key}:${NULL_TO_ABSENT_SUFFIX}`);
      stripped ??= { ...params };
      delete stripped[key];
    }
  }
  return stripped ?? params;
}

export function parseJsonStringArray(
  value: unknown,
  maxItems: number,
): { readonly value: readonly string[]; readonly withinBounds: boolean } | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return { value: parsed, withinBounds: parsed.length <= maxItems };
    }
  } catch {
    // Let each schema preserve its own actionable error.
  }
  return undefined;
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
  const expectedKeys =
    commandId === "node_test"
      ? ["commandId", "force", "paths", "variant"]
      : commandId === "fallow_audit"
        ? ["commandId", "force", "base"]
        : commandId === "node_lint" || commandId === "node_format"
          ? ["commandId", "force", "variant"]
          : ["commandId", "force"];
  const invalidKey = keys.find((key) => !expectedKeys.includes(key));
  if (!keys.includes("commandId") || invalidKey !== undefined) {
    throw invalidRequest(invalidKey ?? "commandId", {
      correctedExample: { commandId },
    });
  }
}

export type NormalizedProjectCommandInput = {
  readonly commandId: string;
  readonly force?: boolean;
  readonly paths?: readonly string[];
  readonly base?: string;
  readonly variant?: string;
  readonly coercions?: readonly string[];
};

function normalizeFallowAuditRequest(
  params: Record<string, unknown>,
  commandId: string,
  coercions: string[],
): NormalizedProjectCommandInput {
  try {
    return {
      commandId,
      base: validateProjectCommandRevision(params.base),
      ...(coercions.length === 0 ? {} : { coercions: [...coercions] }),
    };
  } catch {
    throw invalidRequest("base");
  }
}

function normalizeNodeTestRequest(
  params: Record<string, unknown>,
  commandId: string,
  coercions: string[],
): NormalizedProjectCommandInput {
  try {
    const variant = validateNodeScriptVariant(params.variant, "test");
    const parsedPaths = parseJsonStringArray(params.paths, PROJECT_COMMAND_MAX_PARAMETER_ITEMS);
    if (typeof params.paths === "string" && parsedPaths === undefined) {
      throw invalidRequest("paths", {
        remediation: "Provide paths as an array or an unambiguous JSON array string and retry.",
        correctedExample: { commandId: "node_test", paths: `["src/index.ts"]` },
      });
    }
    if (parsedPaths !== undefined) coercions.push("paths:string-json-array");
    const paths = validateNodeTestPaths(parsedPaths?.value ?? params.paths);
    const base = paths.length === 0 ? { commandId } : { commandId, paths };
    return variant === undefined
      ? { ...base, ...(coercions.length === 0 ? {} : { coercions: [...coercions] }) }
      : { ...base, variant, ...(coercions.length === 0 ? {} : { coercions: [...coercions] }) };
  } catch (error) {
    if (error instanceof ProjectCommandToolError) throw error;
    throw invalidRequest("paths");
  }
}

function normalizeNodeScriptRequest(
  params: Record<string, unknown>,
  commandId: "node_lint" | "node_format",
  coercions: string[],
): NormalizedProjectCommandInput {
  try {
    const variant = validateNodeScriptVariant(
      params.variant,
      commandId === "node_lint" ? "lint" : "format",
    );
    const normalizedEvidence = coercions.length === 0 ? {} : { coercions: [...coercions] };
    return variant === undefined
      ? { commandId, ...normalizedEvidence }
      : { commandId, variant, ...normalizedEvidence };
  } catch (error) {
    if (error instanceof ProjectCommandToolError) throw error;
    throw invalidRequest("variant");
  }
}

function normalizedCommandRequest(
  params: Record<string, unknown>,
  commandId: string,
  coercions: string[],
): NormalizedProjectCommandInput {
  if (commandId === "fallow_audit") {
    return normalizeFallowAuditRequest(params, commandId, coercions);
  }
  if (commandId === "node_test") {
    return normalizeNodeTestRequest(params, commandId, coercions);
  }
  if (commandId === "node_lint" || commandId === "node_format") {
    return normalizeNodeScriptRequest(params, commandId, coercions);
  }
  return {
    commandId,
    ...(coercions.length === 0 ? {} : { coercions: [...coercions] }),
  };
}

const PROJECT_COMMAND_INPUT_KEYS = new Set(["commandId", "force", "paths", "variant", "base"]);

function validateProjectCommandExecution(
  request: Record<string, unknown>,
  definitions: readonly ProjectCommandDefinition[],
  coercions: string[],
): NormalizedProjectCommandInput {
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
  const normalized = normalizedCommandRequest(
    legacyVariant === undefined ? request : { ...request, variant: legacyVariant.variant },
    commandId,
    coercions,
  );
  return force === true ? { ...normalized, force: true } : normalized;
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
    const coercions: string[] = [];
    const stripped = stripNullProperties(params, coercions, PROJECT_COMMAND_INPUT_KEYS) as Record<
      string,
      unknown
    >;
    return validateProjectCommandExecution(stripped, definitions, coercions);
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
  const ref = isRecord(details) ? boundedEvidenceRefSegment(details.ref) : undefined;
  const error = new ProjectCommandToolError(
    ref === undefined
      ? "Project command request cancelled"
      : `Project command request cancelled; ${ref}`,
    isRecord(details)
      ? withToolErrorContract(details, contract)
      : withToolErrorContract({}, contract),
    contract,
  );
  error.name = "AbortError";
  return error;
}
