import type { ResultCategory } from "../errors.ts";
import type { ProjectCommandCacheDecision } from "./cache.ts";
import { definedObjectProperties } from "./defined-properties.ts";
import { sanitizeProjectCommandText } from "./diagnostics.ts";
import type { ProjectCommandOutput } from "./execution.ts";
import type { ProjectCommandOutputDetails } from "./output.ts";

/**
 * Upper bound for a single output stream inside model-facing content.
 * When sanitized output exceeds this bound, both the head and the tail are
 * preserved so that leading context (for example a failing file header) and
 * trailing context (for example lint errors or a summary line) stay visible.
 */
export const PROJECT_COMMAND_MODEL_OUTPUT_MAX_CHARS = 1_200;

const MODEL_OUTPUT_TRUNCATION_MARKER = "\n...[output truncated]...\n";
const MODEL_OUTPUT_CONTENT_CHARS =
  PROJECT_COMMAND_MODEL_OUTPUT_MAX_CHARS - MODEL_OUTPUT_TRUNCATION_MARKER.length;
const MODEL_OUTPUT_HEAD_CHARS = Math.ceil((MODEL_OUTPUT_CONTENT_CHARS * 2) / 3);
const MODEL_OUTPUT_TAIL_CHARS = MODEL_OUTPUT_CONTENT_CHARS - MODEL_OUTPUT_HEAD_CHARS;

function codePointSafePrefixEnd(text: string, end: number): number {
  if (end > 0 && end < text.length) {
    const previous = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      return end - 1;
    }
  }
  return end;
}

function codePointSafeSuffixStart(text: string, start: number): number {
  if (start > 0 && start < text.length) {
    const previous = text.charCodeAt(start - 1);
    const current = text.charCodeAt(start);
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) {
      return start + 1;
    }
  }
  return start;
}

function compactSanitizedModelOutputText(sanitized: string): string {
  if (sanitized.length <= PROJECT_COMMAND_MODEL_OUTPUT_MAX_CHARS) {
    return sanitized;
  }
  const headEnd = codePointSafePrefixEnd(sanitized, MODEL_OUTPUT_HEAD_CHARS);
  const tailStart = codePointSafeSuffixStart(sanitized, sanitized.length - MODEL_OUTPUT_TAIL_CHARS);
  const head = sanitized.slice(0, headEnd);
  const tail = sanitized.slice(tailStart);
  return `${head}${MODEL_OUTPUT_TRUNCATION_MARKER}${tail}`;
}

function compactModelOutputText(text: string): string {
  return compactSanitizedModelOutputText(sanitizeProjectCommandText(text).trim());
}

function compactModelOutput(output: ProjectCommandOutput): ProjectCommandOutput {
  const sanitized = sanitizeProjectCommandText(output.text).trim();
  return {
    ...output,
    text: compactModelOutputText(output.text),
    truncated: output.truncated || sanitized.length > PROJECT_COMMAND_MODEL_OUTPUT_MAX_CHARS,
  };
}

type NodeProjectInfoDetails = {
  readonly nodeVersion?: string;
  readonly manifestPresent?: boolean;
  readonly packageManager?: unknown;
  readonly scripts?: readonly string[];
  readonly applicableCommands?: readonly string[];
};

/**
 * Compact, sanitized projection of result details serialized into tool
 * content for the model. Internal authorization, cache, fingerprint, policy,
 * invocation, and timing metadata stay in `details` (which the cache and
 * tests rely on) and never appear in content.
 */
export interface ProjectCommandModelContent {
  readonly [key: string]: unknown;
  readonly commandId: string;
  readonly projectPath: string;
  readonly status: ProjectCommandOutputDetails["status"];
  readonly category: ResultCategory;
  readonly executed: boolean;
  readonly exit: ProjectCommandOutputDetails["exit"];
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly resolvedCommand: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly stdout: ProjectCommandOutput;
  readonly stderr: ProjectCommandOutput;
  readonly error?: ProjectCommandOutputDetails["error"];
  readonly diagnostic?: string;
  readonly suggestedAction?: string;
  readonly projectInfo?: unknown;
  readonly nodeVersion?: string;
  readonly manifestPresent?: boolean;
  readonly packageManager?: unknown;
  readonly scripts?: readonly string[];
  readonly applicableCommands?: readonly string[];
  readonly reused: boolean;
  readonly forced: boolean;
  readonly cacheDecision: ProjectCommandCacheDecision;
  readonly producerScope?: "session" | "flow";
}

function modelProjectInfo(details: ProjectCommandOutputDetails): Readonly<Record<string, unknown>> {
  const projectInfo = details.projectInfo;
  if (projectInfo === undefined) return {};
  const structured =
    typeof projectInfo === "object" && projectInfo !== null
      ? (projectInfo as NodeProjectInfoDetails)
      : undefined;
  return definedObjectProperties([
    ["projectInfo", projectInfo],
    ["nodeVersion", details.nodeVersion ?? structured?.nodeVersion],
    ["manifestPresent", details.manifestPresent ?? structured?.manifestPresent],
    ["packageManager", details.packageManager ?? structured?.packageManager],
    ["scripts", details.scripts ?? structured?.scripts],
    ["applicableCommands", details.applicableCommands ?? structured?.applicableCommands],
  ]);
}

/**
 * Projects full result details into the compact, sanitized object that is
 * serialized into tool content for the model.
 */
export function projectCommandModelContent(
  details: ProjectCommandOutputDetails,
): ProjectCommandModelContent {
  return {
    commandId: details.commandId,
    projectPath: details.projectPath,
    status: details.status,
    category: details.category,
    executed: details.executed,
    exit: details.exit,
    timedOut: details.timedOut,
    cancelled: details.cancelled,
    resolvedCommand: details.resolvedCommand,
    parameters: details.parameters,
    stdout: compactModelOutput(details.stdout),
    stderr: compactModelOutput(details.stderr),
    ...definedObjectProperties([
      ["error", details.error],
      ["diagnostic", details.diagnostic],
      ["suggestedAction", details.suggestedAction],
    ]),
    ...modelProjectInfo(details),
    reused: details.reused,
    forced: details.forced,
    cacheDecision: details.cacheDecision,
    ...definedObjectProperties([["producerScope", details.producerScope]]),
  };
}
