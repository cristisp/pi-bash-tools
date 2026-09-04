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
      Type.Array(
        Type.String({
          pattern: NODE_TEST_PATH_PATTERN,
          maxLength: PROJECT_COMMAND_MAX_PATH_LENGTH,
        }),
        { maxItems: PROJECT_COMMAND_MAX_PARAMETER_ITEMS, description: "Optional test paths." },
      ),
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
        description: "Return stored validation evidence without executing commands.",
      }),
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
  readonly paths?: readonly string[];
  readonly omit?: readonly VerifyPhase[];
  readonly scripts?: Partial<Record<VerifyPhase, string>>;
  readonly continueOnFailure?: boolean;
  readonly ref?: string;
  readonly covers?: readonly string[];
}

export interface NormalizedVerifyInput {
  readonly paths: readonly string[];
  readonly omit: readonly VerifyPhase[];
  readonly scripts: Readonly<Partial<Record<VerifyPhase, string>>>;
  readonly continueOnFailure: boolean;
  readonly ref?: string;
  readonly covers: readonly string[];
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

export function validateVerifyInput(value: unknown): NormalizedVerifyInput {
  if (!isRecord(value))
    throw new VerifyToolError("invalid-request", "verify input must be an object");
  const allowedKeys = new Set(["paths", "omit", "scripts", "continueOnFailure", "ref", "covers"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new VerifyToolError("invalid-request", "verify input contains an unsupported field");
  }
  const paths = value.paths;
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
      "verify paths must be safe workspace-relative paths",
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
    throw new VerifyToolError("invalid-request", "verify ref is invalid");
  }
  const covers = value.covers;
  if (
    covers !== undefined &&
    (!Array.isArray(covers) ||
      covers.length > 64 ||
      covers.some((cover) => typeof cover !== "string" || cover.length === 0 || cover.length > 512))
  ) {
    throw new VerifyToolError("invalid-request", "verify covers must be bounded strings");
  }
  if (ref !== undefined && Object.keys(value).some((key) => key !== "ref" && key !== "covers")) {
    throw new VerifyToolError(
      "invalid-request",
      "verify ref lookup cannot include execution options",
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
    covers: (covers ?? []) as readonly string[],
  };
}
