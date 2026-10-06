import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { AuthorizationOutcomeRecorder } from "../../observability/authorization-outcome.ts";
import { createAuthorizationOutcomeObserver } from "../../observability/authorization-outcome.ts";
import type { AuthorizationRetryTracker } from "../authorization-retry.ts";
import { renderCallLine, renderStringArgument } from "../call-render.ts";
import { createPolicyStore, createPolicyStoreForTesting } from "../policy/store.ts";
import type { PolicyFileSystem, PolicyStore } from "../policy/types.ts";
import type { LoadedPolicy } from "../policy/types.ts";
import {
  effectiveOrchestrationFlowId,
  readProjectCommandOrchestrationContext,
} from "../project-command/orchestration.ts";
import { toJsonValue } from "../value-validation.ts";
import {
  authorizeAndPersistEnvironmentKeys,
  loadEnvironmentPolicyForRequest,
} from "./environment-authorization.ts";
import {
  environmentCancellationError,
  environmentContract,
  environmentError,
  EnvironmentToolError,
  environmentInputSchema,
  type EnvironmentInput,
  validateEnvironmentKeys,
} from "./environment-schema.ts";
import type { EnvironmentOutput } from "./output.ts";
import { environmentOutputSchema } from "./output.ts";

export interface EnvironmentToolTestOptions {
  readonly configPath: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fs?: Partial<PolicyFileSystem>;
  readonly policy?: PolicyStore;
  readonly authorizationOutcomeRecorder?: AuthorizationOutcomeRecorder;
  readonly authorizationRetryTracker?: AuthorizationRetryTracker;
}

export type EnvironmentToolContext = Omit<
  Pick<ExtensionContext, "cwd" | "signal" | "hasUI" | "mode" | "ui">,
  "ui"
> & {
  readonly ui: Pick<ExtensionContext["ui"], "select">;
  readonly sessionManager?: Pick<ExtensionContext["sessionManager"], "getSessionId">;
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
    structuredContent: toJsonValue(details),
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

function environmentSessionId(ctx: EnvironmentToolContext): string | undefined {
  const value = ctx.sessionManager?.getSessionId();
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function createEnvironmentToolWithDependencies(
  policy: PolicyStore,
  environment: Readonly<Record<string, string | undefined>>,
  authorizationOutcomeRecorder?: AuthorizationOutcomeRecorder,
  authorizationRetryTracker?: AuthorizationRetryTracker,
): EnvironmentToolDefinition {
  return {
    name: "environment",
    label: "Environment",
    description:
      "Read explicitly requested environment variables after user-owned policy authorization. Unauthorized variables are denied in non-interactive modes.",
    promptSnippet: "Read authorized environment variables",
    parameters: environmentInputSchema,
    outputSchema: environmentOutputSchema,
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
      toolCallId,
      params,
      signal,
      _onUpdate: AgentToolUpdateCallback<EnvironmentOutput> | undefined,
      ctx: EnvironmentToolContext,
    ) {
      const keys = validateEnvironmentKeys(params);
      const requestSignal = signal ?? ctx.signal;
      const orchestration = readProjectCommandOrchestrationContext();
      const observe = createAuthorizationOutcomeObserver({
        surface: "environment",
        commandId: "environment",
        recorder: authorizationOutcomeRecorder,
        sessionId: environmentSessionId(ctx),
        toolCallId,
        mode: ctx.mode,
        flowId: effectiveOrchestrationFlowId(orchestration),
        attribution: orchestration,
      });
      let loadedPolicy: LoadedPolicy;
      try {
        loadedPolicy = await loadEnvironmentPolicyForRequest(policy, ctx.cwd, requestSignal);
      } catch (error) {
        if (!(error instanceof EnvironmentToolError && error.contract.code === "cancelled")) {
          observe?.({
            outcome: "policy-load-failure",
            decisionPersisted: false,
            promptEmitted: false,
            promptWaitMs: 0,
          });
        }
        throw error;
      }
      await authorizeAndPersistEnvironmentKeys(
        keys,
        ctx,
        loadedPolicy,
        policy,
        requestSignal,
        observe,
        authorizationRetryTracker,
      );
      return makeEnvironmentToolResult({
        values: readEnvironmentValues(keys, environment, requestSignal),
      });
    },
  };
}

export function createEnvironmentTool(
  authorizationOutcomeRecorder?: AuthorizationOutcomeRecorder,
  authorizationRetryTracker?: AuthorizationRetryTracker,
): EnvironmentToolDefinition {
  return createEnvironmentToolWithDependencies(
    createPolicyStore(),
    process.env,
    authorizationOutcomeRecorder,
    authorizationRetryTracker,
  );
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
  return createEnvironmentToolWithDependencies(
    policy,
    options.environment ?? process.env,
    options.authorizationOutcomeRecorder,
    options.authorizationRetryTracker,
  );
}
