import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

export const BASH_TOOLS_INVOCATIONS_PATH = "BASH_TOOLS_INVOCATIONS_PATH";
const BASH_TOOLS_INVOCATION_STREAM = "BASH_TOOLS_INVOCATION_STREAM";
const BASH_TOOLS_TELEMETRY_PATH = "BASH_TOOLS_TELEMETRY_PATH";

const INVOCATION_STREAM_ENVIRONMENT_VARIABLES = [
  BASH_TOOLS_INVOCATIONS_PATH,
  BASH_TOOLS_INVOCATION_STREAM,
  BASH_TOOLS_TELEMETRY_PATH,
] as const;

const invocationStreamWarnings = new Set<string>();

function warnInvocationStream(path: string, message: string): void {
  const warningKey = `${path}:${message}`;
  if (invocationStreamWarnings.has(warningKey)) return;
  invocationStreamWarnings.add(warningKey);
  process.emitWarning(message, { code: "BASH_TOOLS_INVOCATION_STREAM" });
}

function configuredInvocationStreamPath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  for (const environmentVariable of INVOCATION_STREAM_ENVIRONMENT_VARIABLES) {
    const value = environment[environmentVariable];
    if (value === undefined || value.trim().length === 0) continue;
    const path = value.trim();
    if (!isAbsolute(path)) {
      warnInvocationStream(path, `${environmentVariable} must contain an absolute JSONL file path`);
      return undefined;
    }
    return path;
  }
  return undefined;
}

/** Append one record to the configured JSONL invocation stream, best effort and bounded. */
export function appendInvocationStreamRecord(
  record: unknown,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const path = configuredInvocationStreamPath(environment);
  if (path === undefined) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { readonly code?: unknown }).code)
        : "unknown";
    warnInvocationStream(path, `Could not append the invocation stream (${code})`);
  }
}
