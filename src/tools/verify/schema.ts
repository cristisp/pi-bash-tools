import { Type } from "typebox";
import {
  NODE_TEST_PATH_PATTERN,
  PROJECT_COMMAND_MAX_PARAMETER_ITEMS,
  PROJECT_COMMAND_MAX_PATH_LENGTH,
  PROJECT_COMMAND_MAX_SCRIPT_VARIANT_LENGTH,
  PROJECT_COMMAND_SCRIPT_VARIANT_PATTERN,
} from "../project-command/parameters.ts";
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function jsonStringArray(value: unknown, field: string): readonly string[] | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    // Fall through to the actionable validation error below.
  }
  throw new VerifyToolError(
    "invalid-request",
    `verify field ${field} must be an array or a JSON array string; expected string[], for example ["src/index.ts"]`,
  );
}

export function validateVerifyInput(value: unknown): NormalizedVerifyInput {
  if (!isRecord(value))
    throw new VerifyToolError("invalid-request", "verify input must be an object");
  const allowedKeys = new Set([
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
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new VerifyToolError("invalid-request", "verify input contains an unsupported field");
  }
  const coercions: string[] = [];
  const rawPaths = value.paths;
  const coercedPaths = jsonStringArray(rawPaths, "paths");
  if (coercedPaths !== undefined) coercions.push("paths:string-json-array");
  const paths = coercedPaths ?? rawPaths;
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
  const normalizedOmit = (omit ?? []).filter(isPhase);
  const scriptsValue = value.scripts;
  const scripts: Partial<Record<VerifyPhase, string>> = {};
  if (scriptsValue !== undefined) {
    if (!isRecord(scriptsValue)) {
      throw new VerifyToolError("invalid-request", "verify scripts must be an object");
    }
    for (const [phase, script] of Object.entries(scriptsValue)) {
      if (!isPhase(phase) || !isSafeScriptName(script)) {
        throw new VerifyToolError(
          "invalid-request",
          "verify scripts must name exact package scripts",
        );
      }
      scripts[phase] = script;
    }
  }
  if (value.continueOnFailure !== undefined && typeof value.continueOnFailure !== "boolean") {
    throw new VerifyToolError("invalid-request", "continueOnFailure must be a boolean");
  }
  if (normalizedOmit.some((phase) => scripts[phase] !== undefined)) {
    throw new VerifyToolError("invalid-request", "omitted verify phases cannot select a script");
  }
  const ref = value.ref;
  if (ref !== undefined && (typeof ref !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(ref))) {
    throw new VerifyToolError(
      "invalid-request",
      'verify field ref must be a bounded reference string; expected string, for example "vr_example"',
    );
  }
  const flowId = value.flowId;
  if (
    flowId !== undefined &&
    (typeof flowId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(flowId))
  ) {
    throw new VerifyToolError(
      "invalid-request",
      'verify field flowId must be a bounded lookup scope and requires ref; expected string, for example "flow-1"',
    );
  }
  const fresh = value.fresh;
  if (fresh !== undefined && typeof fresh !== "boolean") {
    throw new VerifyToolError(
      "invalid-request",
      "verify field fresh must be boolean; expected boolean, for example true",
    );
  }
  const publishValue = value.publish;
  let publish: { readonly flowId: string } | undefined;
  if (publishValue !== undefined) {
    if (
      !isRecord(publishValue) ||
      typeof publishValue.flowId !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/u.test(publishValue.flowId) ||
      Object.keys(publishValue).some((key) => key !== "flowId")
    ) {
      throw new VerifyToolError(
        "invalid-request",
        'verify field publish must be {flowId: string}; expected object, for example {flowId: "flow-1"}',
      );
    }
    publish = { flowId: publishValue.flowId };
  }
  const covers = value.covers;
  if (
    covers !== undefined &&
    (!Array.isArray(covers) ||
      covers.length > 64 ||
      covers.some((cover) => typeof cover !== "string" || cover.length === 0 || cover.length > 512))
  ) {
    throw new VerifyToolError(
      "invalid-request",
      'verify field covers must be bounded strings; expected string[], for example ["AC-001"]',
    );
  }
  if (
    ref !== undefined &&
    (fresh === true ||
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
  if (ref === undefined && normalizedOmit.length === VERIFY_PHASES.length) {
    throw new VerifyToolError("invalid-request", "verify must run at least one phase");
  }
  return {
    paths: (paths ?? []) as readonly string[],
    omit: normalizedOmit,
    scripts,
    continueOnFailure: value.continueOnFailure === true,
    ...(ref === undefined ? {} : { ref }),
    ...(flowId === undefined ? {} : { flowId }),
    fresh: fresh === true,
    ...(publish === undefined ? {} : { publish }),
    covers: (covers ?? []) as readonly string[],
    coercions,
  };
}
