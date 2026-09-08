import { expect, it, vi } from "vitest";

import { authorizeOrPrompt, type AuthorizeOrPromptOptions } from "../src/tools/authorization.ts";
import { findEnvironmentPolicyDecision } from "../src/tools/policy/decisions.ts";
import { parsePolicyDocument } from "../src/tools/policy/document.ts";
import type { EnvironmentDecisionRequest, LoadedPolicy } from "../src/tools/policy/types.ts";

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
