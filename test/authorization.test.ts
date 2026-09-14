/* oxlint-disable typescript/no-unsafe-type-assertion, eslint/no-await-in-loop */

import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import type {
  AuthorizationOutcomeCore,
  AuthorizationOutcomeObserver,
} from "../src/observability/authorization-outcome.ts";
import { authorizeOrPrompt, type AuthorizeOrPromptOptions } from "../src/tools/authorization.ts";
import {
  findEnvironmentPolicyDecision,
  findProjectCommandPolicyDecision,
} from "../src/tools/policy/decisions.ts";
import { parsePolicyDocument } from "../src/tools/policy/document.ts";
import { createPolicyStoreForTesting } from "../src/tools/policy/store.ts";
import type {
  CommandIdentity,
  EnvironmentDecisionRequest,
  LoadedPolicy,
} from "../src/tools/policy/types.ts";

const projectPath = "/tmp/authorization-project";

function loaded(timeout = 120_000): LoadedPolicy {
  const document = parsePolicyDocument(
    JSON.stringify({ version: 1, confirmationTimeoutMs: timeout }),
  );
  return { projectPath, confirmationTimeoutMs: timeout, document };
}

function options(
  overrides: Partial<AuthorizeOrPromptOptions<string, EnvironmentDecisionRequest>> = {},
): AuthorizeOrPromptOptions<string, EnvironmentDecisionRequest> {
  return {
    identity: "TOKEN",
    loaded: loaded(),
    context: {
      hasUI: true,
      mode: "tui",
      ui: { select: async () => "Allow for this project" },
    },
    signal: undefined,
    globalSafe: true,
    deferAllowPersistence: false,
    findDecision: (current, identity) => findEnvironmentPolicyDecision(current, identity),
    recordDecisions: vi.fn(async () => undefined),
    makeRequest: (identity, decision) => ({ kind: "environment", key: identity, decision }),
    promptText: (identity) => `Authorize ${identity}`,
    error: (kind) => new Error(kind),
    ...overrides,
  };
}

it("uses an existing authorization without prompting", async () => {
  const current = loaded();
  const policy = {
    ...current.document,
    environment: {
      ...current.document.environment,
      global: { allow: ["TOKEN"], deny: [] },
    },
  };
  const select = vi.fn(async () => "Allow globally");
  const result = await authorizeOrPrompt(
    options({
      loaded: { ...current, document: policy },
      context: { hasUI: true, mode: "tui", ui: { select } },
    }),
  );
  expect(result).toBeUndefined();
  expect(select).not.toHaveBeenCalled();
});

it("rejects unknown requests without eligible UI", async () => {
  await expect(
    authorizeOrPrompt(
      options({
        context: { hasUI: false, mode: "print", ui: { select: async () => undefined } },
      }),
    ),
  ).rejects.toThrow("not-authorized");
});

it("notifies before an orchestrated manual approval prompt", async () => {
  const previousDelegationId = process.env.PI_DELEGATION_ID;
  process.env.PI_DELEGATION_ID = "child-1";
  try {
    const notify = vi.fn();
    const select = vi.fn(async () => "Allow once");
    const result = await authorizeOrPrompt(
      options({ context: { hasUI: true, mode: "tui", ui: { select, notify } } }),
    );
    expect(result).toBeUndefined();
    expect(notify).toHaveBeenCalledWith(
      "Subagent is waiting for manual policy approval.",
      "warning",
    );
    expect(select).toHaveBeenCalledOnce();
  } finally {
    if (previousDelegationId === undefined) {
      delete process.env.PI_DELEGATION_ID;
    } else {
      process.env.PI_DELEGATION_ID = previousDelegationId;
    }
  }
});

it("uses the exact choices and title and defers an allow", async () => {
  const select = vi.fn(async (title: string, choices: readonly string[]) => {
    expect(title).toBe("Authorize TOKEN");
    expect(choices).toEqual([
      "Deny once",
      "Deny globally",
      "Deny for this project",
      "Allow once",
      "Allow globally",
      "Allow for this project",
    ]);
    return "Allow for this project";
  });
  const record = vi.fn(async () => undefined);
  const request = await authorizeOrPrompt(
    options({
      context: { hasUI: true, mode: "rpc", ui: { select } },
      deferAllowPersistence: true,
      recordDecisions: record,
    }),
  );
  expect(request).toEqual({ kind: "environment", key: "TOKEN", decision: "allow-project" });
  expect(record).not.toHaveBeenCalled();
});

it("allows once without persisting a decision", async () => {
  const record = vi.fn(async () => undefined);
  const result = await authorizeOrPrompt(
    options({
      context: {
        hasUI: true,
        mode: "tui",
        ui: { select: async () => "Allow once" },
      },
      recordDecisions: record,
    }),
  );

  expect(result).toBeUndefined();
  expect(record).not.toHaveBeenCalled();
});

it("restricts choices when global authorization is unavailable", async () => {
  const select = vi.fn(async (_title: string, choices: readonly string[]) => {
    expect(choices).toEqual([
      "Deny once",
      "Deny for this project",
      "Allow once",
      "Allow for this project",
    ]);
    return "Allow for this project";
  });

  await expect(
    authorizeOrPrompt(
      options({
        allowGlobal: false,
        deferAllowPersistence: true,
        context: { hasUI: true, mode: "tui", ui: { select } },
      }),
    ),
  ).resolves.toEqual({ kind: "environment", key: "TOKEN", decision: "allow-project" });
  expect(select).toHaveBeenCalledOnce();
});

it.each(["Deny globally", "Allow globally"])(
  "rejects the %s choice when global authorization is unavailable",
  async (choice) => {
    const record = vi.fn(async () => undefined);
    await expect(
      authorizeOrPrompt(
        options({
          allowGlobal: false,
          context: { hasUI: true, mode: "tui", ui: { select: async () => choice } },
          recordDecisions: record,
        }),
      ),
    ).rejects.toThrow("unsafe-global");
    expect(record).not.toHaveBeenCalled();
  },
);

it("reports a policy lookup failure without prompting", async () => {
  const select = vi.fn(async () => "Allow once");
  await expect(
    authorizeOrPrompt(
      options({
        findDecision: () => {
          throw new Error("policy unavailable");
        },
        context: { hasUI: true, mode: "tui", ui: { select } },
      }),
    ),
  ).rejects.toThrow("load");
  expect(select).not.toHaveBeenCalled();
});

it("reports a decision persistence failure", async () => {
  const record = vi.fn(async () => {
    throw new Error("policy is read-only");
  });
  await expect(
    authorizeOrPrompt(
      options({
        context: { hasUI: true, mode: "rpc", ui: { select: async () => "Deny globally" } },
        recordDecisions: record,
      }),
    ),
  ).rejects.toThrow("save");
  expect(record).toHaveBeenCalledOnce();
});

it("denies once without persisting a decision", async () => {
  const record = vi.fn(async () => undefined);
  await expect(
    authorizeOrPrompt(
      options({
        context: {
          hasUI: true,
          mode: "tui",
          ui: { select: async () => "Deny once" },
        },
        recordDecisions: record,
      }),
    ),
  ).rejects.toThrow("denied-once");
  expect(record).not.toHaveBeenCalled();
});

it("persists a deny immediately and reports denial", async () => {
  const record = vi.fn(async () => undefined);
  await expect(
    authorizeOrPrompt(
      options({
        context: {
          hasUI: true,
          mode: "tui",
          ui: { select: async () => "Deny globally" },
        },
        recordDecisions: record,
      }),
    ),
  ).rejects.toThrow("denied");
  expect(record).toHaveBeenCalledWith(
    projectPath,
    [{ kind: "environment", key: "TOKEN", decision: "deny-global" }],
    undefined,
  );
});

it("persists timeout as project deny", async () => {
  const record = vi.fn(async () => undefined);
  await expect(
    authorizeOrPrompt(
      options({
        loaded: loaded(1),
        context: {
          hasUI: true,
          mode: "rpc",
          ui: { select: () => new Promise<string | undefined>(() => undefined) },
        },
        recordDecisions: record,
      }),
    ),
  ).rejects.toThrow("timeout");
  expect(record).toHaveBeenCalledWith(
    projectPath,
    [{ kind: "environment", key: "TOKEN", decision: "deny-project" }],
    undefined,
  );
});

it("does not persist on cancellation or unsafe global allow", async () => {
  const controller = new AbortController();
  const record = vi.fn(async () => undefined);
  controller.abort();
  await expect(
    authorizeOrPrompt(options({ signal: controller.signal, recordDecisions: record })),
  ).rejects.toThrow("cancelled");
  expect(record).not.toHaveBeenCalled();

  await expect(
    authorizeOrPrompt(
      options({
        globalSafe: false,
        context: {
          hasUI: true,
          mode: "tui",
          ui: { select: async () => "Allow globally" },
        },
        recordDecisions: record,
      }),
    ),
  ).rejects.toThrow("unsafe-global");
});

it.each([
  [undefined, "dismissed"],
  ["unexpected choice", "invalid-choice"],
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  [null as unknown as string, "invalid-choice"],
] as const)("rejects malformed prompt result %j", async (choice, errorKind) => {
  const record = vi.fn(async () => undefined);
  await expect(
    authorizeOrPrompt(
      options({
        context: {
          hasUI: true,
          mode: "tui",
          ui: { select: async () => choice },
        },
        recordDecisions: record,
      }),
    ),
  ).rejects.toThrow(errorKind);
  expect(record).not.toHaveBeenCalled();
});

it("turns a prompt failure into a confirmation error without persisting", async () => {
  const record = vi.fn(async () => undefined);
  await expect(
    authorizeOrPrompt(
      options({
        context: {
          hasUI: true,
          mode: "tui",
          ui: { select: async () => Promise.reject(new Error("prompt failed")) },
        },
        recordDecisions: record,
      }),
    ),
  ).rejects.toThrow("confirmation");
  expect(record).not.toHaveBeenCalled();
});

it("cancels a pending prompt without treating it as a decision", async () => {
  const controller = new AbortController();
  const record = vi.fn(async () => undefined);
  const execution = authorizeOrPrompt(
    options({
      signal: controller.signal,
      context: {
        hasUI: true,
        mode: "rpc",
        ui: { select: () => new Promise<string | undefined>(() => undefined) },
      },
      recordDecisions: record,
    }),
  );

  controller.abort();
  await expect(execution).rejects.toThrow("cancelled");
  expect(record).not.toHaveBeenCalled();
});

it("persists each project denial and returns each deferred approval as its decision", async () => {
  const decisions = [
    ["Deny for this project", "deny-project", "denied"],
    ["Allow for this project", "allow-project", undefined],
  ] as const;

  await Promise.all(
    decisions.map(async ([choice, decision, errorKind]) => {
      const record = vi.fn(async () => undefined);
      const result = authorizeOrPrompt(
        options({
          context: { hasUI: true, mode: "tui", ui: { select: async () => choice } },
          deferAllowPersistence: true,
          recordDecisions: record,
        }),
      );

      if (errorKind === undefined) {
        await expect(result).resolves.toEqual({
          kind: "environment",
          key: "TOKEN",
          decision,
        });
        expect(record).not.toHaveBeenCalled();
      } else {
        await expect(result).rejects.toThrow(errorKind);
        expect(record).toHaveBeenCalledWith(
          projectPath,
          [{ kind: "environment", key: "TOKEN", decision }],
          undefined,
        );
      }
    }),
  );
});

it("records an authorized outcome without a prompt when policy already allows", async () => {
  const current = loaded();
  const policy = {
    ...current.document,
    environment: {
      ...current.document.environment,
      global: { allow: ["TOKEN"], deny: [] },
    },
  };
  const outcomes: AuthorizationOutcomeCore[] = [];
  await authorizeOrPrompt(
    options({
      loaded: { ...current, document: policy },
      observe: (core) => outcomes.push(core),
    }),
  );
  expect(outcomes).toEqual([
    {
      outcome: "authorized",
      decisionPersisted: false,
      executionAttempted: undefined,
      promptEmitted: false,
      promptWaitMs: 0,
      decisionSource: "allow-global",
    },
  ]);
});

it("records a denied outcome without prompting when policy denies", async () => {
  const current = loaded();
  const policy = {
    ...current.document,
    environment: {
      ...current.document.environment,
      global: { allow: [], deny: ["TOKEN"] },
    },
  };
  const outcomes: AuthorizationOutcomeCore[] = [];
  await expect(
    authorizeOrPrompt(
      options({
        loaded: { ...current, document: policy },
        observe: (core) => outcomes.push(core),
      }),
    ),
  ).rejects.toThrow("denied");
  expect(outcomes).toEqual([
    {
      outcome: "denied",
      decisionPersisted: false,
      executionAttempted: undefined,
      promptEmitted: false,
      promptWaitMs: 0,
      decisionSource: "deny-global",
    },
  ]);
});

it("records a not-authorized outcome in non-interactive modes", async () => {
  const outcomes: AuthorizationOutcomeCore[] = [];
  await expect(
    authorizeOrPrompt(
      options({
        context: { hasUI: false, mode: "print", ui: { select: async () => undefined } },
        observe: (core) => outcomes.push(core),
      }),
    ),
  ).rejects.toThrow("not-authorized");
  expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["not-authorized"]);
});

it("records prompt-based outcomes for allow-once, deferred, persisted, and denials", async () => {
  const cases = [
    { choice: "Allow once", outcome: "allowed-once", persisted: false, rejects: false },
    { choice: "Deny once", outcome: "denied-once", persisted: false, rejects: true },
    {
      choice: "Allow for this project",
      outcome: "deferred-persistence",
      persisted: false,
      rejects: false,
    },
    { choice: "Deny for this project", outcome: "denied", persisted: true, rejects: true },
  ] as const;
  for (const testCase of cases) {
    const outcomes: AuthorizationOutcomeCore[] = [];
    const execution = authorizeOrPrompt(
      options({
        context: { hasUI: true, mode: "tui", ui: { select: async () => testCase.choice } },
        deferAllowPersistence: testCase.choice === "Allow for this project",
        observe: (core) => outcomes.push(core),
      }),
    );
    if (testCase.rejects) {
      await expect(execution).rejects.toThrow();
    } else if (testCase.outcome === "deferred-persistence") {
      await expect(execution).resolves.toBeDefined();
    } else {
      await expect(execution).resolves.toBeUndefined();
    }
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      outcome: testCase.outcome,
      decisionPersisted: testCase.persisted,
      promptEmitted: true,
    });
    expect(outcomes[0]?.promptWaitMs).toBeGreaterThanOrEqual(0);
  }
});

it("records an allowed-and-persisted outcome when deferral is off", async () => {
  const outcomes: AuthorizationOutcomeCore[] = [];
  const recordDecisions = vi.fn(async () => undefined);
  await authorizeOrPrompt(
    options({
      recordDecisions,
      observe: (core) => outcomes.push(core),
    }),
  );
  expect(outcomes).toEqual([
    {
      outcome: "allowed-and-persisted",
      decisionPersisted: true,
      executionAttempted: undefined,
      promptEmitted: true,
      promptWaitMs: expect.any(Number),
      decisionSource: "prompt",
    },
  ]);
});

it("records a save failure when persisting a denial fails", async () => {
  const outcomes: AuthorizationOutcomeCore[] = [];
  await expect(
    authorizeOrPrompt(
      options({
        context: {
          hasUI: true,
          mode: "tui",
          ui: { select: async () => "Deny for this project" },
        },
        recordDecisions: async () => {
          throw new Error("disk full");
        },
        observe: (core) => outcomes.push(core),
      }),
    ),
  ).rejects.toThrow("save");
  expect(outcomes).toEqual([
    {
      outcome: "policy-save-failure",
      decisionPersisted: false,
      executionAttempted: undefined,
      promptEmitted: true,
      promptWaitMs: expect.any(Number),
    },
  ]);
});

it("records a confirmation timeout outcome with the persisted deny", async () => {
  const outcomes: AuthorizationOutcomeCore[] = [];
  await expect(
    authorizeOrPrompt(
      options({
        loaded: loaded(1),
        context: {
          hasUI: true,
          mode: "rpc",
          ui: { select: () => new Promise<string | undefined>(() => undefined) },
        },
        observe: (core) => outcomes.push(core),
      }),
    ),
  ).rejects.toThrow("timeout");
  expect(outcomes).toEqual([
    {
      outcome: "confirmation-timeout",
      decisionPersisted: true,
      executionAttempted: undefined,
      promptEmitted: true,
      promptWaitMs: expect.any(Number),
      decisionSource: "prompt",
    },
  ]);
});

it("records a policy-save-failure outcome without persistence when the deny write fails", async () => {
  const outcomes: AuthorizationOutcomeCore[] = [];
  await expect(
    authorizeOrPrompt(
      options({
        loaded: loaded(1),
        context: {
          hasUI: true,
          mode: "rpc",
          ui: { select: () => new Promise<string | undefined>(() => undefined) },
        },
        recordDecisions: async () => {
          throw new Error("disk full");
        },
        observe: (core) => outcomes.push(core),
      }),
    ),
  ).rejects.toThrow("save");
  expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["policy-save-failure"]);
  expect(outcomes[0]).toMatchObject({ decisionPersisted: false, promptEmitted: true });
});

it("keeps the policy-save-failure outcome for a timed-out prompt when the fresh lookup stays unknown", async () => {
  const outcomes: AuthorizationOutcomeCore[] = [];
  await expect(
    authorizeOrPrompt(
      options({
        loaded: loaded(1),
        context: {
          hasUI: true,
          mode: "rpc",
          ui: { select: () => new Promise<string | undefined>(() => undefined) },
        },
        recordDecisions: async () => {
          throw new Error("disk full");
        },
        reload: async () => loaded(),
        observe: (core) => outcomes.push(core),
      }),
    ),
  ).rejects.toThrow("save");
  expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["policy-save-failure"]);
  expect(outcomes[0]).toMatchObject({ decisionPersisted: false, promptEmitted: true });
});

it("observes cancellation when the abort lands during the reload", async () => {
  const controller = new AbortController();
  const outcomes: AuthorizationOutcomeCore[] = [];
  await expect(
    authorizeOrPrompt(
      options({
        loaded: loaded(1),
        signal: controller.signal,
        context: {
          hasUI: true,
          mode: "rpc",
          ui: { select: () => new Promise<string | undefined>(() => undefined) },
        },
        recordDecisions: async () => {
          throw new Error("disk full");
        },
        reload: async () => {
          controller.abort();
          return loaded();
        },
        observe: (core) => outcomes.push(core),
      }),
    ),
  ).rejects.toThrow("cancelled");
  expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["cancelled"]);
});

it("recovers a timed-out prompt when a concurrent allow is already persisted", async () => {
  const outcomes: AuthorizationOutcomeCore[] = [];
  const fresh = loadedWithEnvironment({ global: { allow: ["TOKEN"] } });
  await expect(
    authorizeOrPrompt(
      options({
        loaded: loaded(1),
        context: {
          hasUI: true,
          mode: "rpc",
          ui: { select: () => new Promise<string | undefined>(() => undefined) },
        },
        recordDecisions: async () => {
          throw new Error("opposite decision");
        },
        reload: async () => fresh,
        observe: (core) => outcomes.push(core),
      }),
    ),
  ).resolves.toBeUndefined();
  expect(outcomes).toEqual([
    {
      outcome: "authorized",
      decisionPersisted: false,
      executionAttempted: undefined,
      promptEmitted: true,
      promptWaitMs: expect.any(Number),
      decisionSource: "allow-global",
    },
  ]);
});

it("recovers an explicit denial when a concurrent allow is already persisted", async () => {
  const outcomes: AuthorizationOutcomeCore[] = [];
  const fresh = loadedWithEnvironment({ global: { allow: ["TOKEN"] } });
  await expect(
    authorizeOrPrompt(
      options({
        context: {
          hasUI: true,
          mode: "tui",
          ui: { select: async () => "Deny for this project" },
        },
        recordDecisions: async () => {
          throw new Error("opposite decision");
        },
        reload: async () => fresh,
        observe: (core) => outcomes.push(core),
      }),
    ),
  ).resolves.toBeUndefined();
  expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["authorized"]);
  expect(outcomes[0]).toMatchObject({ decisionSource: "allow-global", promptEmitted: true });
});

it("reports a persistent concurrent denial after a failed deny persist", async () => {
  const outcomes: AuthorizationOutcomeCore[] = [];
  const fresh = loadedWithEnvironment({ global: { deny: ["TOKEN"] } });
  await expect(
    authorizeOrPrompt(
      options({
        context: {
          hasUI: true,
          mode: "tui",
          ui: { select: async () => "Deny for this project" },
        },
        recordDecisions: async () => {
          throw new Error("conflict");
        },
        reload: async () => fresh,
        observe: (core) => outcomes.push(core),
      }),
    ),
  ).rejects.toThrow("denied");
  expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["denied"]);
  expect(outcomes[0]).toMatchObject({ decisionSource: "deny-global", promptEmitted: true });
});

it("keeps the save failure when the fresh policy lookup fails", async () => {
  const outcomes: AuthorizationOutcomeCore[] = [];
  await expect(
    authorizeOrPrompt(
      options({
        context: {
          hasUI: true,
          mode: "tui",
          ui: { select: async () => "Deny for this project" },
        },
        recordDecisions: async () => {
          throw new Error("disk full");
        },
        reload: async () => {
          throw new Error("reload failed");
        },
        observe: (core) => outcomes.push(core),
      }),
    ),
  ).rejects.toThrow("save");
  expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["policy-save-failure"]);
});

it("records cancelled, dismissed, invalid-choice, unsafe-global, and lookup failures", async () => {
  const controller = new AbortController();
  const cancelled: AuthorizationOutcomeCore[] = [];
  const execution = authorizeOrPrompt(
    options({
      signal: controller.signal,
      context: {
        hasUI: true,
        mode: "rpc",
        ui: { select: () => new Promise<string | undefined>(() => undefined) },
      },
      observe: (core) => cancelled.push(core),
    }),
  );
  controller.abort();
  await expect(execution).rejects.toThrow("cancelled");
  expect(cancelled.map((outcome) => outcome.outcome)).toEqual(["cancelled"]);

  const dismissed: AuthorizationOutcomeCore[] = [];
  await expect(
    authorizeOrPrompt(
      options({
        context: { hasUI: true, mode: "tui", ui: { select: async () => undefined } },
        observe: (core) => dismissed.push(core),
      }),
    ),
  ).rejects.toThrow("dismissed");
  expect(dismissed.map((outcome) => outcome.outcome)).toEqual(["dismissed"]);

  const invalid: AuthorizationOutcomeCore[] = [];
  await expect(
    authorizeOrPrompt(
      options({
        context: { hasUI: true, mode: "tui", ui: { select: async () => "Nonsense" } },
        observe: (core) => invalid.push(core),
      }),
    ),
  ).rejects.toThrow("invalid-choice");
  expect(invalid.map((outcome) => outcome.outcome)).toEqual(["invalid-choice"]);

  const unsafe: AuthorizationOutcomeCore[] = [];
  await expect(
    authorizeOrPrompt(
      options({
        globalSafe: false,
        context: { hasUI: true, mode: "tui", ui: { select: async () => "Allow globally" } },
        observe: (core) => unsafe.push(core),
      }),
    ),
  ).rejects.toThrow("unsafe-global");
  expect(unsafe.map((outcome) => outcome.outcome)).toEqual(["unsafe-global"]);

  const lookupFailure: AuthorizationOutcomeCore[] = [];
  await expect(
    authorizeOrPrompt(
      options({
        findDecision: () => {
          throw new Error("lookup failed");
        },
        observe: (core) => lookupFailure.push(core),
      }),
    ),
  ).rejects.toThrow("load");
  expect(lookupFailure.map((outcome) => outcome.outcome)).toEqual(["decision-lookup-failure"]);
  expect(lookupFailure[0]).toMatchObject({ promptEmitted: false, decisionPersisted: false });
});

function loadedWithEnvironment(
  environment: {
    readonly global?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] };
    readonly project?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] };
  },
  timeout = 120_000,
): LoadedPolicy {
  const base = loaded(timeout);
  return {
    ...base,
    document: {
      ...base.document,
      environment: {
        ...base.document.environment,
        global: {
          allow: [...(environment.global?.allow ?? [])],
          deny: [...(environment.global?.deny ?? [])],
        },
        projects:
          environment.project === undefined
            ? {}
            : {
                [projectPath]: {
                  allow: [...(environment.project.allow ?? [])],
                  deny: [...(environment.project.deny ?? [])],
                },
              },
      },
    },
  };
}

interface ScenarioResult {
  readonly settled: "resolved" | "rejected";
  readonly value: unknown;
  readonly errorKind: string | undefined;
  readonly recordCalls: readonly unknown[];
  readonly decisionSources: readonly (string | undefined)[];
}

async function runScenario(
  overrides: Partial<AuthorizeOrPromptOptions<string, EnvironmentDecisionRequest>>,
  observe: AuthorizationOutcomeObserver | undefined,
): Promise<ScenarioResult> {
  const recordCalls: unknown[] = [];
  const decisionSources: (string | undefined)[] = [];
  const recorder: AuthorizationOutcomeObserver | undefined =
    observe === undefined
      ? undefined
      : (core) => {
          decisionSources.push(core.decisionSource);
          observe(core);
        };
  const recordDecisions = async (
    path: string,
    requests: readonly EnvironmentDecisionRequest[],
  ): Promise<void> => {
    recordCalls.push({ path, requests: requests.map((request) => ({ ...request })) });
  };
  try {
    const value = await authorizeOrPrompt(
      options({ ...overrides, recordDecisions, observe: recorder }),
    );
    return {
      settled: "resolved",
      value: value ?? null,
      errorKind: undefined,
      recordCalls,
      decisionSources,
    };
  } catch (error) {
    return {
      settled: "rejected",
      value: null,
      errorKind: error instanceof Error ? error.message : String(error),
      recordCalls,
      decisionSources,
    };
  }
}

const PRECEDENCE_SCENARIOS: ReadonlyArray<{
  readonly name: string;
  readonly decisionSource: string | undefined;
  readonly overrides: Partial<AuthorizeOrPromptOptions<string, EnvironmentDecisionRequest>>;
}> = [
  {
    name: "configured global allow",
    decisionSource: "allow-global",
    overrides: { loaded: loadedWithEnvironment({ global: { allow: ["TOKEN"] } }) },
  },
  {
    name: "configured project allow",
    decisionSource: "allow-project",
    overrides: { loaded: loadedWithEnvironment({ project: { allow: ["TOKEN"] } }) },
  },
  {
    name: "configured global deny",
    decisionSource: "deny-global",
    overrides: { loaded: loadedWithEnvironment({ global: { deny: ["TOKEN"] } }) },
  },
  {
    name: "configured project deny",
    decisionSource: "deny-project",
    overrides: { loaded: loadedWithEnvironment({ project: { deny: ["TOKEN"] } }) },
  },
  {
    name: "non-interactive not authorized",
    decisionSource: undefined,
    overrides: {
      context: { hasUI: false, mode: "print", ui: { select: async () => undefined } },
    },
  },
  {
    name: "prompt deny once",
    decisionSource: "prompt",
    overrides: { context: { hasUI: true, mode: "tui", ui: { select: async () => "Deny once" } } },
  },
  {
    name: "prompt allow once",
    decisionSource: "prompt",
    overrides: {
      context: { hasUI: true, mode: "tui", ui: { select: async () => "Allow once" } },
    },
  },
  {
    name: "prompt allow for this project",
    decisionSource: "prompt",
    overrides: {
      context: {
        hasUI: true,
        mode: "tui",
        ui: { select: async () => "Allow for this project" },
      },
    },
  },
  {
    name: "prompt deny for this project",
    decisionSource: "prompt",
    overrides: {
      context: {
        hasUI: true,
        mode: "tui",
        ui: { select: async () => "Deny for this project" },
      },
    },
  },
  {
    name: "prompt unsafe global",
    decisionSource: "prompt",
    overrides: {
      globalSafe: false,
      context: { hasUI: true, mode: "tui", ui: { select: async () => "Allow globally" } },
    },
  },
  {
    name: "prompt invalid choice",
    decisionSource: "prompt",
    overrides: {
      context: { hasUI: true, mode: "tui", ui: { select: async () => "Nonsense" } },
    },
  },
  {
    name: "prompt dismissed",
    decisionSource: undefined,
    overrides: {
      context: { hasUI: true, mode: "tui", ui: { select: async () => undefined } },
    },
  },
  {
    name: "prompt confirmation failure",
    decisionSource: undefined,
    overrides: {
      context: {
        hasUI: true,
        mode: "tui",
        ui: { select: async () => Promise.reject(new Error("prompt failed")) },
      },
    },
  },
  {
    name: "confirmation timeout",
    decisionSource: "prompt",
    overrides: {
      loaded: loaded(1),
      context: {
        hasUI: true,
        mode: "rpc",
        ui: { select: () => new Promise<string | undefined>(() => undefined) },
      },
    },
  },
];

it.each(PRECEDENCE_SCENARIOS)(
  "keeps $name decisions identical with and without outcome attribution",
  async (scenario) => {
    const without = await runScenario(scenario.overrides, undefined);
    const withAttribution = await runScenario(scenario.overrides, () => undefined);

    expect(withAttribution.settled).toBe(without.settled);
    expect(withAttribution.errorKind).toBe(without.errorKind);
    expect(withAttribution.value).toEqual(without.value);
    expect(withAttribution.recordCalls).toEqual(without.recordCalls);
    expect(withAttribution.decisionSources.length).toBeGreaterThan(0);
    expect(withAttribution.decisionSources).toContain(scenario.decisionSource);
    expect(withAttribution.decisionSources).not.toContain("unknown");
    expect(without.decisionSources).toEqual([]);
  },
);

type ProjectCommandPromptOptions = AuthorizeOrPromptOptions<
  CommandIdentity,
  import("../src/tools/policy/types.ts").ProjectCommandDecisionRequest
>;

async function createRealPolicyStore(prefix: string): Promise<{
  store: ReturnType<typeof createPolicyStoreForTesting>;
  policyRoot: string;
  identity: CommandIdentity;
}> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const policyRoot = await realpath(directory);
  const configPath = join(policyRoot, "bash-tools.json");
  await writeFile(configPath, JSON.stringify({ version: 1, confirmationTimeoutMs: 1 }));
  const store = createPolicyStoreForTesting({ configPath });
  return {
    store,
    policyRoot,
    identity: { commandId: "verify", fingerprint: "f".repeat(64) },
  };
}

function realStorePromptOptions(
  store: ReturnType<typeof createPolicyStoreForTesting>,
  policyRoot: string,
  overrides: Partial<Omit<ProjectCommandPromptOptions, "identity" | "loaded">> = {},
): Omit<ProjectCommandPromptOptions, "identity" | "loaded"> {
  return {
    context: {
      hasUI: true,
      mode: "rpc",
      ui: {
        select: () => new Promise<string | undefined>(() => undefined),
      },
    },
    signal: undefined,
    globalSafe: false,
    deferAllowPersistence: false,
    findDecision: (current, currentIdentity) =>
      findProjectCommandPolicyDecision(current, currentIdentity, false),
    reload: () => store.load(policyRoot),
    recordDecisions: (recordPath, requests, recordSignal) =>
      store.recordDecisions(recordPath, requests, recordSignal),
    makeRequest: (currentIdentity, decision) => ({
      kind: "project-command",
      identity: currentIdentity,
      decision,
      globalSafe: false,
    }),
    promptText: (currentIdentity) => `Authorize ${currentIdentity.commandId}`,
    error: (kind) => new Error(kind),
    ...overrides,
  };
}

it("recovers a timed-out prompt from a real policy store after a concurrent allow", async () => {
  const { store, policyRoot, identity } = await createRealPolicyStore(
    "bash-tools-authorization-recovery-",
  );
  await store.recordDecisions(policyRoot, [
    { kind: "project-command", identity, decision: "allow-project", globalSafe: false },
  ]);
  await expect(
    authorizeOrPrompt<
      CommandIdentity,
      import("../src/tools/policy/types.ts").ProjectCommandDecisionRequest
    >({
      ...realStorePromptOptions(store, policyRoot),
      identity,
      loaded: await store.load(policyRoot),
    }),
  ).resolves.toBeUndefined();
});

it("surfaces a save failure from a real policy store when the fresh lookup stays unknown", async () => {
  const { store, policyRoot, identity } = await createRealPolicyStore(
    "bash-tools-authorization-save-",
  );
  const outcomes: AuthorizationOutcomeCore[] = [];
  await expect(
    authorizeOrPrompt<
      CommandIdentity,
      import("../src/tools/policy/types.ts").ProjectCommandDecisionRequest
    >({
      ...realStorePromptOptions(store, policyRoot, {
        recordDecisions: async () => {
          throw new Error("forced save failure");
        },
        observe: (core) => outcomes.push(core),
      }),
      identity,
      loaded: await store.load(policyRoot),
    }),
  ).rejects.toThrow("save");
  expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["policy-save-failure"]);
});
