import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { renderCallLine, renderStringArgument } from "../call-render.ts";
import { createPolicyStore, createPolicyStoreForTesting } from "../policy/store.ts";
import type { PolicyFileSystem, PolicyStore } from "../policy/types.ts";
import {
  authorizeAndPersistEnvironmentKeys,
  loadEnvironmentPolicyForRequest,
} from "./environment-authorization.ts";
import {
  environmentCancellationError,
  environmentContract,
  environmentError,
  environmentInputSchema,
  type EnvironmentInput,
  validateEnvironmentKeys,
} from "./environment-schema.ts";
import type { EnvironmentOutput } from "./output.ts";

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

function environmentReadFailure(): ReturnType<typeof environmentError> {
  return environmentError(
    "Unable to read requested environment values",
    environmentContract(
      "environment-read-failure",
      "ENVIRONMENT_FAILURE",
      "The requested environment values could not be read.",
      true,
      true,
    ),
  );
}

function readEnvironmentValues(
  keys: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  signal: AbortSignal | undefined,
): Readonly<Record<string, string | null>> {
  if (signal?.aborted) {
    throw environmentCancellationError();
  }
  try {
    const values = Object.fromEntries(keys.map((key) => [key, environment[key] ?? null]));
    if (signal?.aborted) {
      throw environmentCancellationError(true);
    }
    return values;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    if (signal?.aborted) {
      throw environmentCancellationError(true);
    }
    throw environmentReadFailure();
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
    renderCall(args, theme) {
      const keys = Array.isArray(args?.keys) ? args.keys : [];
      return renderCallLine(
        theme,
        "environment",
        keys.map((key) => renderStringArgument(key, theme)),
      );
    },
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
      return makeEnvironmentToolResult({
        values: readEnvironmentValues(keys, environment, requestSignal),
      });
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
