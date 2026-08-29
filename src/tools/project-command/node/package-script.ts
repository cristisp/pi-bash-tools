import type { ProjectCommandDefinition } from "../definitions.ts";
import {
  PROJECT_COMMAND_MAX_SCRIPT_VARIANT_LENGTH,
  PROJECT_COMMAND_SCRIPT_VARIANT_PATTERN,
} from "../parameters.ts";

const scriptVariantPattern = new RegExp(PROJECT_COMMAND_SCRIPT_VARIANT_PATTERN, "u");
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function variantParameter(parameters: unknown): string | undefined {
  if (!isRecord(parameters)) return undefined;
  const variant = parameters.variant;
  return typeof variant === "string" ? variant : undefined;
}

export function isValidNodePackageScriptVariant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= PROJECT_COMMAND_MAX_SCRIPT_VARIANT_LENGTH &&
    scriptVariantPattern.test(value)
  );
}

export function nodePackageScriptVariantKey(family: string, variant: string): string | undefined {
  if (!isValidNodePackageScriptVariant(variant)) return undefined;
  return `${family}:${variant}`;
}

export function hasNodePackageScriptVariant(
  scripts: Readonly<Record<string, string>>,
  family: string,
): boolean {
  const prefix = `${family}:`;
  return Object.keys(scripts).some(
    (scriptKey) =>
      scriptKey.startsWith(prefix) &&
      nodePackageScriptVariantKey(family, scriptKey.slice(prefix.length)) !== undefined,
  );
}

export function nodePackageScriptKey(
  definition: ProjectCommandDefinition,
  parameters: unknown,
): string | undefined {
  const base = definition.fixedScriptKey;
  if (base === undefined) return undefined;
  const variant = variantParameter(parameters);
  if (variant === undefined) {
    return definition.requiresVariant === true ? undefined : base;
  }
  const family = definition.scriptVariantFamily;
  return family === undefined ? undefined : nodePackageScriptVariantKey(family, variant);
}
