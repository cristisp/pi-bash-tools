import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  EnvironmentToolError,
  environmentInputSchema,
  type EnvironmentInput,
  validateEnvironmentKeys,
} from "./environment-schema.ts";
import {
  authorizeAndPersistEnvironmentKeys,
  loadEnvironmentPolicyForRequest,
} from "./environment-authorization.ts";
import type { EnvironmentOutput } from "./output.ts";
import { createPolicyStore, createPolicyStoreForTesting } from "../policy/store.ts";
import type { PolicyFileSystem, PolicyStore } from "../policy/types.ts";

export interface EnvironmentToolTestOptions {
  readonly configPath: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fs?: Partial<PolicyFileSystem>;
  readonly policy?: PolicyStore;
}

export type EnvironmentToolContext = Omit<
  Pick<ExtensionContext, "cwd" | "signal" | "hasUI" | "mode" | "ui">,
  "ui"
> & {
  readonly ui: Pick<ExtensionContext["ui"], "select">;
};

type EnvironmentToolExecute = (
  toolCallId: string,
  params: EnvironmentInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<EnvironmentOutput> | undefined,
  ctx: EnvironmentToolContext,
) => Promise<AgentToolResult<EnvironmentOutput>>;

export type EnvironmentToolDefinition = Omit<
  ToolDefinition<typeof environmentInputSchema, EnvironmentOutput>,
  "execute"
> & { execute: EnvironmentToolExecute };

function makeEnvironmentToolResult(details: EnvironmentOutput): AgentToolResult<EnvironmentOutput> {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  };
}

function readEnvironmentValues(
  keys: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | null>> {
  try {
    return Object.fromEntries(keys.map((key) => [key, environment[key] ?? null]));
  } catch {
    throw new EnvironmentToolError("Unable to read requested environment values");
  }
}

function createEnvironmentToolWithDependencies(
  policy: PolicyStore,
  environment: Readonly<Record<string, string | undefined>>,
): EnvironmentToolDefinition {
  return {
    name: "environment",
    label: "Environment",
    description:
      "Read explicitly requested environment variables after user-owned policy authorization. Unauthorized variables are denied in non-interactive modes.",
    promptSnippet: "Read authorized environment variables",
    parameters: environmentInputSchema,
    executionMode: "sequential",
    async execute(
      _toolCallId,
      params,
      signal,
      _onUpdate: AgentToolUpdateCallback<EnvironmentOutput> | undefined,
      ctx: EnvironmentToolContext,
    ) {
      const keys = validateEnvironmentKeys(params);
      const requestSignal = signal ?? ctx.signal;
      const loadedPolicy = await loadEnvironmentPolicyForRequest(policy, ctx.cwd, requestSignal);
      await authorizeAndPersistEnvironmentKeys(keys, ctx, loadedPolicy, policy, requestSignal);
      return makeEnvironmentToolResult({ values: readEnvironmentValues(keys, environment) });
    },
  };
}

export function createEnvironmentTool(): EnvironmentToolDefinition {
  return createEnvironmentToolWithDependencies(createPolicyStore(), process.env);
}

export function createEnvironmentToolForTesting(
  options: EnvironmentToolTestOptions,
): EnvironmentToolDefinition {
  const policy =
    options.policy ??
    createPolicyStoreForTesting({
      configPath: options.configPath,
      fs: options.fs,
    });
  return createEnvironmentToolWithDependencies(policy, options.environment ?? process.env);
}
