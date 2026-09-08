import { Type } from "typebox";

import {
  NODE_TEST_PATH_PATTERN,
  PROJECT_COMMAND_MAX_PARAMETER_ITEMS,
  PROJECT_COMMAND_MAX_PATH_LENGTH,
  PROJECT_COMMAND_MAX_SCRIPT_VARIANT_LENGTH,
  PROJECT_COMMAND_SCRIPT_VARIANT_PATTERN,
} from "../project-command/parameters.ts";
import { parseJsonStringArray } from "../project-command/schema/validation.ts";
import { isRecord, isValidPublishValue } from "../value-validation.ts";
import { VERIFY_PHASES, type VerifyPhase } from "./types.ts";

const packageScriptNamePattern = PROJECT_COMMAND_SCRIPT_VARIANT_PATTERN;
const packageScriptNameRegex = new RegExp(packageScriptNamePattern, "u");
const nodeTestPathPattern = new RegExp(NODE_TEST_PATH_PATTERN, "u");
const verifyPhaseSchema = Type.Union(VERIFY_PHASES.map((phase) => Type.Literal(phase)));
const packageScriptSchema = Type.String({
  pattern: packageScriptNamePattern,
  maxLength: PROJECT_COMMAND_MAX_SCRIPT_VARIANT_LENGTH,
});

export const verifyInputSchema = Type.Object(
  {
    paths: Type.Optional(
      Type.Union([
        Type.Array(
          Type.String({
            pattern: NODE_TEST_PATH_PATTERN,
            maxLength: PROJECT_COMMAND_MAX_PATH_LENGTH,
          }),
          { maxItems: PROJECT_COMMAND_MAX_PARAMETER_ITEMS, description: "Optional test paths." },
        ),
        Type.String({
          description: 'JSON array of workspace-relative test paths, for example ["src/index.ts"].',
        }),
      ]),
    ),
    omit: Type.Optional(
      Type.Array(verifyPhaseSchema, {
        maxItems: VERIFY_PHASES.length,
        uniqueItems: true,
        description: "Explicitly omit selected verification phases.",
      }),
    ),
    scripts: Type.Optional(
      Type.Object(
        {
          format: Type.Optional(packageScriptSchema),
          lint: Type.Optional(packageScriptSchema),
          typecheck: Type.Optional(packageScriptSchema),
          test: Type.Optional(packageScriptSchema),
        },
        { additionalProperties: false, description: "Exact package.json script names by phase." },
      ),
    ),
    continueOnFailure: Type.Optional(
      Type.Boolean({ description: "Run later phases after a phase fails." }),
    ),
    ref: Type.Optional(
      Type.String({
        pattern: "^[A-Za-z0-9_-]{8,128}$",
        description:
          "Lookup-only stored validation evidence; use with optional flowId and no execution options.",
      }),
    ),
    flowId: Type.Optional(
      Type.String({
        pattern: "^[A-Za-z0-9_-]{1,64}$",
        description: "Lookup-only evidence flow scope; requires ref.",
      }),
    ),
    fresh: Type.Optional(
      Type.Boolean({ description: "Force fresh execution; cannot be combined with ref." }),
    ),
    publish: Type.Optional(
      Type.Object(
        {
          flowId: Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }),
        },
        {
          additionalProperties: false,
          description: "Publish execution evidence to this flow after successful authorization.",
        },
      ),
    ),
    covers: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
        maxItems: 64,
        description: "Opaque acceptance-criteria identifiers to preserve in evidence.",
      }),
    ),
  },
  { additionalProperties: false },
);

export interface VerifyInput {
  readonly paths?: readonly string[] | string;
  readonly omit?: readonly VerifyPhase[];
  readonly scripts?: Partial<Record<VerifyPhase, string>>;
  readonly continueOnFailure?: boolean;
  readonly ref?: string;
  readonly flowId?: string;
  readonly fresh?: boolean;
  readonly publish?: { readonly flowId: string };
  readonly covers?: readonly string[];
}

export interface NormalizedVerifyInput {
  readonly paths: readonly string[];
  readonly omit: readonly VerifyPhase[];
  readonly scripts: Readonly<Partial<Record<VerifyPhase, string>>>;
  readonly continueOnFailure: boolean;
  readonly ref?: string;
  readonly flowId?: string;
  readonly fresh: boolean;
  readonly publish?: { readonly flowId: string };
  readonly covers: readonly string[];
  readonly coercions: readonly string[];
}

export class VerifyToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "VerifyToolError";
    this.code = code;
  }
}

function isPhase(value: unknown): value is VerifyPhase {
  return typeof value === "string" && (VERIFY_PHASES as readonly string[]).includes(value);
}

function isSafeScriptName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= PROJECT_COMMAND_MAX_SCRIPT_VARIANT_LENGTH &&
    packageScriptNameRegex.test(value)
  );
}

interface VerifyExecutionFields {
  readonly paths: readonly string[];
  readonly omit: readonly VerifyPhase[];
  readonly scripts: Partial<Record<VerifyPhase, string>>;
  readonly continueOnFailure: boolean;
}

function validateVerifyPathArray(paths: unknown): readonly string[] {
  if (
    paths !== undefined &&
    (!Array.isArray(paths) ||
      paths.length > PROJECT_COMMAND_MAX_PARAMETER_ITEMS ||
      paths.some(
        (path) =>
          typeof path !== "string" ||
          path.length === 0 ||
          path.length > PROJECT_COMMAND_MAX_PATH_LENGTH ||
          !nodeTestPathPattern.test(path),
      ))
  ) {
    throw new VerifyToolError(
      "invalid-request",
      'verify field paths must be safe workspace-relative paths; expected string[], for example ["src/index.ts"]',
    );
  }
  return (paths ?? []) as readonly string[];
}

function validateVerifyPaths(
  value: Readonly<Record<string, unknown>>,
  coercions: string[],
): readonly string[] {
  const rawPaths = value.paths;
  const coercedPaths = parseJsonStringArray(rawPaths, PROJECT_COMMAND_MAX_PARAMETER_ITEMS);
  if (typeof rawPaths === "string" && coercedPaths === undefined) {
    throw new VerifyToolError(
      "invalid-request",
      'verify field paths must be an array or a JSON array string; expected string[], for example ["src/index.ts"]',
    );
  }
  if (coercedPaths !== undefined) coercions.push("paths:string-json-array");
  return validateVerifyPathArray(coercedPaths?.value ?? rawPaths);
}

function validateVerifyOmit(value: Readonly<Record<string, unknown>>): readonly VerifyPhase[] {
  const omit = value.omit;
  if (
    omit !== undefined &&
    (!Array.isArray(omit) ||
      omit.length > VERIFY_PHASES.length ||
      omit.some((phase) => !isPhase(phase)) ||
      new Set(omit).size !== omit.length)
  ) {
    throw new VerifyToolError("invalid-request", "verify omit must contain unique known phases");
  }
  return (omit ?? []).filter(isPhase);
}

function validateVerifyScripts(
  value: Readonly<Record<string, unknown>>,
): Partial<Record<VerifyPhase, string>> {
  const scripts: Partial<Record<VerifyPhase, string>> = {};
  if (value.scripts === undefined) return scripts;
  if (!isRecord(value.scripts)) {
    throw new VerifyToolError("invalid-request", "verify scripts must be an object");
  }
  for (const [phase, script] of Object.entries(value.scripts)) {
    if (!isPhase(phase) || !isSafeScriptName(script)) {
      throw new VerifyToolError(
        "invalid-request",
        "verify scripts must name exact package scripts",
      );
    }
    scripts[phase] = script;
  }
  return scripts;
}

function validateContinueOnFailure(value: Readonly<Record<string, unknown>>): boolean {
  if (value.continueOnFailure !== undefined && typeof value.continueOnFailure !== "boolean") {
    throw new VerifyToolError("invalid-request", "continueOnFailure must be a boolean");
  }
  return value.continueOnFailure === true;
}

function validateVerifyExecutionFields(
  value: Readonly<Record<string, unknown>>,
  coercions: string[],
): VerifyExecutionFields {
  const paths = validateVerifyPaths(value, coercions);
  const omit = validateVerifyOmit(value);
  const scripts = validateVerifyScripts(value);
  const continueOnFailure = validateContinueOnFailure(value);
  if (omit.some((phase) => scripts[phase] !== undefined)) {
    throw new VerifyToolError("invalid-request", "omitted verify phases cannot select a script");
  }
  return { paths, omit, scripts, continueOnFailure };
}

interface VerifyEvidenceFields {
  readonly ref?: string;
  readonly flowId?: string;
  readonly fresh: boolean;
  readonly publish?: { readonly flowId: string };
  readonly covers: readonly string[];
}

function validateVerifyRef(value: unknown): string | undefined {
  if (
    value !== undefined &&
    (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(value))
  ) {
    throw new VerifyToolError(
      "invalid-request",
      'verify field ref must be a bounded reference string; expected string, for example "vr_example"',
    );
  }
  return value;
}

function validateVerifyFlowId(value: unknown): string | undefined {
  if (value !== undefined && (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(value))) {
    throw new VerifyToolError(
      "invalid-request",
      'verify field flowId must be a bounded lookup scope and requires ref; expected string, for example "flow-1"',
    );
  }
  return value;
}

function validateVerifyFresh(value: unknown): boolean {
  if (value !== undefined && typeof value !== "boolean") {
    throw new VerifyToolError(
      "invalid-request",
      "verify field fresh must be boolean; expected boolean, for example true",
    );
  }
  return value === true;
}

function validateVerifyPublish(value: unknown): { readonly flowId: string } | undefined {
  if (value === undefined) return undefined;
  if (!isValidPublishValue(value)) {
    throw new VerifyToolError(
      "invalid-request",
      'verify field publish must be {flowId: string}; expected object, for example {flowId: "flow-1"}',
    );
  }
  return { flowId: value.flowId };
}

function validateVerifyCovers(value: unknown): readonly string[] {
  if (
    value !== undefined &&
    (!Array.isArray(value) ||
      value.length > 64 ||
      value.some((cover) => typeof cover !== "string" || cover.length === 0 || cover.length > 512))
  ) {
    throw new VerifyToolError(
      "invalid-request",
      'verify field covers must be bounded strings; expected string[], for example ["AC-001"]',
    );
  }
  return (value ?? []) as readonly string[];
}

function validateVerifyEvidenceFields(
  value: Readonly<Record<string, unknown>>,
): VerifyEvidenceFields {
  const ref = validateVerifyRef(value.ref);
  const flowId = validateVerifyFlowId(value.flowId);
  const fresh = validateVerifyFresh(value.fresh);
  const publish = validateVerifyPublish(value.publish);
  const covers = validateVerifyCovers(value.covers);
  return {
    ...(ref === undefined ? {} : { ref }),
    ...(flowId === undefined ? {} : { flowId }),
    fresh,
    ...(publish === undefined ? {} : { publish }),
    covers,
  };
}

const VERIFY_INPUT_KEYS = new Set([
  "paths",
  "omit",
  "scripts",
  "continueOnFailure",
  "ref",
  "flowId",
  "fresh",
  "publish",
  "covers",
]);

function validateVerifyInputKeys(value: Readonly<Record<string, unknown>>): void {
  if (Object.keys(value).some((key) => !VERIFY_INPUT_KEYS.has(key))) {
    throw new VerifyToolError("invalid-request", "verify input contains an unsupported field");
  }
}

function validateVerifyLookupRestrictions(
  value: Readonly<Record<string, unknown>>,
  evidence: VerifyEvidenceFields,
  omit: readonly VerifyPhase[],
): void {
  const { ref, flowId, fresh, publish } = evidence;
  if (
    ref !== undefined &&
    (fresh ||
      publish !== undefined ||
      Object.keys(value).some((key) => !["ref", "flowId", "covers"].includes(key)))
  ) {
    throw new VerifyToolError(
      "invalid-request",
      'verify ref lookup cannot include execution options; expected {ref} or {ref,flowId}, for example {ref: "vr_example", flowId: "flow-1"}',
    );
  }
  if (flowId !== undefined && ref === undefined) {
    throw new VerifyToolError(
      "invalid-request",
      'verify field flowId is lookup-only and requires ref; expected {ref,flowId}, for example {ref: "vr_example", flowId: "flow-1"}',
    );
  }
  if (ref === undefined && omit.length === VERIFY_PHASES.length) {
    throw new VerifyToolError("invalid-request", "verify must run at least one phase");
  }
}

export function validateVerifyInput(value: unknown): NormalizedVerifyInput {
  if (!isRecord(value))
    throw new VerifyToolError("invalid-request", "verify input must be an object");
  validateVerifyInputKeys(value);
  const coercions: string[] = [];
  const executionFields = validateVerifyExecutionFields(value, coercions);
  const { paths, omit, scripts, continueOnFailure } = executionFields;
  const evidence = validateVerifyEvidenceFields(value);
  validateVerifyLookupRestrictions(value, evidence, omit);
  return {
    paths,
    omit,
    scripts,
    continueOnFailure,
    ...(evidence.ref === undefined ? {} : { ref: evidence.ref }),
    ...(evidence.flowId === undefined ? {} : { flowId: evidence.flowId }),
    fresh: evidence.fresh ?? false,
    ...(evidence.publish === undefined ? {} : { publish: evidence.publish }),
    covers: evidence.covers,
    coercions,
  };
}
