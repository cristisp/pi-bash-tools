import { createHash } from "node:crypto";
import { join } from "node:path";
import type { NodeFileSystem, NodeManifest } from "../types.ts";
import { isMissingFileError, projectStateResolutionError } from "./errors.ts";

export const NODE_SCRIPT_COMMANDS = [
  { commandId: "node_test", script: "test" },
  { commandId: "node_test_coverage", script: "test:coverage" },
  { commandId: "node_e2e", script: "test:e2e" },
  { commandId: "node_build", script: "build" },
  { commandId: "node_lint", script: "lint" },
  { commandId: "node_lint_fix", script: "lint:fix" },
  { commandId: "node_typecheck", script: "typecheck" },
  { commandId: "node_format_check", script: "format:check" },
  { commandId: "node_format_write", script: "format" },
] as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNodeManifestInternal(source: string): NodeManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw projectStateResolutionError("detection", "invalid-package-manifest");
  }
  if (!isRecord(parsed)) {
    throw projectStateResolutionError("detection", "invalid-package-manifest");
  }
  const rawScripts = parsed.scripts;
  if (rawScripts !== undefined && !isRecord(rawScripts)) {
    throw projectStateResolutionError("detection", "invalid-package-manifest");
  }
  const scripts: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawScripts ?? {})) {
    if (typeof value !== "string") {
      throw projectStateResolutionError("detection", "invalid-package-manifest");
    }
    scripts[name] = value;
  }
  return Object.freeze({
    scripts: Object.freeze(scripts),
    packageManager: parsed.packageManager,
    hasPackageManager: Object.prototype.hasOwnProperty.call(parsed, "packageManager"),
  });
}

export async function readNodeManifestInternal(
  projectPath: string,
  fileSystem: NodeFileSystem,
  allowMissing: boolean,
): Promise<NodeManifest | null> {
  let source: string;
  try {
    source = await fileSystem.readFile(join(projectPath, "package.json"), "utf8");
  } catch (error) {
    if (allowMissing && isMissingFileError(error)) {
      return null;
    }
    throw projectStateResolutionError(
      "probe",
      isMissingFileError(error) ? "missing-package-manifest" : "manifest-read-failed",
    );
  }
  return parseNodeManifestInternal(source);
}

export function canonicalizeNodeScriptsInternal(scripts: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(scripts).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
  );
}

export function hashNodeScriptsInternal(scripts: Readonly<Record<string, string>>): string {
  return createHash("sha256")
    .update(canonicalizeNodeScriptsInternal(scripts), "utf8")
    .digest("hex");
}
