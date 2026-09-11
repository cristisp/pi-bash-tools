import { expect, it, vi } from "vitest";

import type { AuthorizationOutcomeCore } from "../src/observability/authorization-outcome.ts";
import {
  authorizationRequestFingerprint,
  createAuthorizationRetryTracker,
} from "../src/tools/authorization-retry.ts";
import { authorizeOrPrompt, type AuthorizeOrPromptOptions } from "../src/tools/authorization.ts";
import { findEnvironmentPolicyDecision } from "../src/tools/policy/decisions.ts";
import type {
  EnvironmentDecisionRequest,
  LoadedPolicy,
  PolicyDocument,
} from "../src/tools/policy/types.ts";

const projectPath = "/tmp/authorization-retry-project";
const fingerprint = authorizationRequestFingerprint({ kind: "environment", key: "TOKEN" });

function document(
  projects: Record<string, { readonly allow: readonly string[]; readonly deny: readonly string[] }>,
): PolicyDocument {
  return {
    version: 1,
    environment: {
      version: 1,
      confirmationTimeoutMs: 120_000,
      global: { allow: [], deny: [] },
      projects,
    },
  };
}

function loaded(
  projects: Record<string, { readonly allow: readonly string[]; readonly deny: readonly string[] }>,
  timeout = 120_000,
): LoadedPolicy {
  return { projectPath, confirmationTimeoutMs: timeout, document: document(projects) };
}

function options(
  tracker: ReturnType<typeof createAuthorizationRetryTracker> | undefined,
  overrides: Partial<AuthorizeOrPromptOptions<string, EnvironmentDecisionRequest>> & {
    readonly current?: () => LoadedPolicy;
  } = {},
): AuthorizeOrPromptOptions<string, EnvironmentDecisionRequest> {
  const { current, ...rest } = overrides;
  return {
    identity: "TOKEN",
    loaded: (current ?? (() => loaded({})))(),
    context: {
      hasUI: true,
      mode: "tui",
      ui: { select: async () => "Deny for this project" },
    },
    signal: undefined,
    globalSafe: true,
    deferAllowPersistence: false,
    findDecision: (currentLoaded, identity) =>
      findEnvironmentPolicyDecision(currentLoaded, identity),
    recordDecisions: vi.fn(async () => undefined),
    makeRequest: (identity, decision) => ({ kind: "environment", key: identity, decision }),
    promptText: (identity) => `Authorize ${identity}`,
    error: (kind) => new Error(kind),
    ...(tracker === undefined
      ? {}
      : {
          retry: { tracker, surface: "environment" as const, sessionId: "session-1", fingerprint },
        }),
    ...rest,
  };
}

function mutableProjects() {
  const projects: Record<string, { allow: string[]; deny: string[] }> = {};
  return projects;
}

it("tracks persistent denials per session, surface, and fingerprint", () => {
  const tracker = createAuthorizationRetryTracker();
  const key = { sessionId: "session-1", surface: "environment" as const, fingerprint };
  tracker.recordPersistentDenial(key, "denied");

  expect(tracker.findUnchangedRetry(key)).toEqual({ reason: "denied", ageMs: expect.any(Number) });
  expect(
    tracker.findUnchangedRetry({
      sessionId: "session-2",
      surface: "environment",
      fingerprint,
    }),
  ).toBeUndefined();
  expect(
    tracker.findUnchangedRetry({ sessionId: "session-1", surface: "verify", fingerprint }),
  ).toBeUndefined();
  expect(
    tracker.findUnchangedRetry({
      sessionId: "session-1",
      surface: "environment",
      fingerprint: "other",
    }),
  ).toBeUndefined();
});

it("evicts the oldest entries beyond the bounded capacity", () => {
  const tracker = createAuthorizationRetryTracker(2);
  const first = { sessionId: "s", surface: "environment" as const, fingerprint: "first" };
  const second = { sessionId: "s", surface: "environment" as const, fingerprint: "second" };
  const third = { sessionId: "s", surface: "environment" as const, fingerprint: "third" };

  tracker.recordPersistentDenial(first, "denied");
  tracker.recordPersistentDenial(second, "confirmation-timeout");
  tracker.recordPersistentDenial(third, "denied");

  expect(tracker.findUnchangedRetry(first)).toBeUndefined();
  expect(tracker.findUnchangedRetry(second)?.reason).toBe("confirmation-timeout");
  expect(tracker.findUnchangedRetry(third)?.reason).toBe("denied");
});

it("refreshes an existing entry instead of growing the map", () => {
  const tracker = createAuthorizationRetryTracker(1);
  const key = { sessionId: "s", surface: "environment" as const, fingerprint: "f" };
  tracker.recordPersistentDenial(key, "denied");
  tracker.recordPersistentDenial(key, "confirmation-timeout");
  expect(tracker.findUnchangedRetry(key)?.reason).toBe("confirmation-timeout");
});

it("classifies an identical retry after a persistent policy denial", async () => {
  const tracker = createAuthorizationRetryTracker();
  const outcomes: AuthorizationOutcomeCore[] = [];
  const select = vi.fn(async () => "Deny for this project");
  const policy = loaded({ [projectPath]: { allow: [], deny: ["TOKEN"] } });

  await expect(
    authorizeOrPrompt(
      options(tracker, {
        loaded: policy,
        context: { hasUI: true, mode: "tui", ui: { select } },
        observe: (core) => outcomes.push(core),
      }),
    ),
  ).rejects.toThrow("denied");
  expect(select).not.toHaveBeenCalled();
  expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["denied"]);

  outcomes.length = 0;
  const secondSelect = vi.fn(async () => "Deny for this project");
  await expect(
    authorizeOrPrompt(
      options(tracker, {
        loaded: policy,
        context: { hasUI: true, mode: "tui", ui: { select: secondSelect } },
        observe: (core) => outcomes.push(core),
      }),
    ),
  ).rejects.toThrow("unchanged-retry");
  expect(secondSelect).not.toHaveBeenCalled();
  expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["unchanged-retry-after-denial"]);
  expect(outcomes[0]).toMatchObject({ decisionPersisted: false, promptEmitted: false });
});

it("does not classify retries without a session identity", async () => {
  const tracker = createAuthorizationRetryTracker();
  const policy = loaded({ [projectPath]: { allow: [], deny: ["TOKEN"] } });
  const noSession = (
    overrides: Partial<AuthorizeOrPromptOptions<string, EnvironmentDecisionRequest>>,
  ) =>
    options(tracker, {
      ...overrides,
      retry: undefined,
    });

  await expect(authorizeOrPrompt(noSession({ loaded: policy }))).rejects.toThrow("denied");
  await expect(authorizeOrPrompt(noSession({ loaded: policy }))).rejects.toThrow("denied");
  expect(
    tracker.findUnchangedRetry({ sessionId: "session-1", surface: "environment", fingerprint }),
  ).toBeUndefined();
});

it("does not classify a different request as an unchanged retry", async () => {
  const tracker = createAuthorizationRetryTracker();
  const policy = loaded({ [projectPath]: { allow: [], deny: ["TOKEN"] } });
  await expect(authorizeOrPrompt(options(tracker, { loaded: policy }))).rejects.toThrow("denied");
  await expect(
    authorizeOrPrompt(
      options(tracker, {
        loaded: policy,
        retry: {
          tracker,
          surface: "environment",
          sessionId: "session-1",
          fingerprint: authorizationRequestFingerprint({ kind: "environment", key: "OTHER" }),
        },
      }),
    ),
  ).rejects.toThrow("denied");
});

it("classifies an identical retry after a persisted prompt denial", async () => {
  const tracker = createAuthorizationRetryTracker();
  const projects = mutableProjects();
  const select = vi.fn(async () => "Deny for this project");
  const current = () => loaded(projects);
  const recordDecisions = vi.fn(
    async (
      _projectPath: string,
      requests: readonly EnvironmentDecisionRequest[],
    ): Promise<void> => {
      const scope = projects[projectPath] ?? { allow: [], deny: [] };
      for (const request of requests) {
        if (request.kind === "environment" && request.decision === "deny-project") {
          scope.deny.push(request.key);
        }
      }
      projects[projectPath] = scope;
    },
  );

  await expect(
    authorizeOrPrompt(
      options(tracker, {
        current,
        recordDecisions,
        context: { hasUI: true, mode: "tui", ui: { select } },
      }),
    ),
  ).rejects.toThrow("denied");
  expect(select).toHaveBeenCalledOnce();

  const secondSelect = vi.fn(async () => "Deny for this project");
  await expect(
    authorizeOrPrompt(
      options(tracker, {
        current,
        context: { hasUI: true, mode: "tui", ui: { select: secondSelect } },
      }),
    ),
  ).rejects.toThrow("unchanged-retry");
  expect(secondSelect).not.toHaveBeenCalled();
});

it("classifies an identical retry after a persisted confirmation timeout", async () => {
  const tracker = createAuthorizationRetryTracker();
  const projects = mutableProjects();
  const current = () => loaded(projects, 1);
  const recordDecisions = vi.fn(
    async (
      _projectPath: string,
      requests: readonly EnvironmentDecisionRequest[],
    ): Promise<void> => {
      const scope = projects[projectPath] ?? { allow: [], deny: [] };
      for (const request of requests) {
        if (request.kind === "environment" && request.decision === "deny-project") {
          scope.deny.push(request.key);
        }
      }
      projects[projectPath] = scope;
    },
  );
  const select = (): Promise<string | undefined> => new Promise(() => undefined);

  await expect(
    authorizeOrPrompt(
      options(tracker, {
        current,
        recordDecisions,
        context: { hasUI: true, mode: "rpc", ui: { select } },
      }),
    ),
  ).rejects.toThrow("timeout");

  const secondSelect = vi.fn(select);
  await expect(
    authorizeOrPrompt(
      options(tracker, {
        current,
        context: { hasUI: true, mode: "rpc", ui: { select: secondSelect } },
      }),
    ),
  ).rejects.toThrow("unchanged-retry");
  expect(secondSelect).not.toHaveBeenCalled();
});

it("keeps a normal denial when the policy later allows the request", async () => {
  const tracker = createAuthorizationRetryTracker();
  await expect(
    authorizeOrPrompt(
      options(tracker, { loaded: loaded({ [projectPath]: { allow: [], deny: ["TOKEN"] } }) }),
    ),
  ).rejects.toThrow("denied");
  await expect(
    authorizeOrPrompt(
      options(tracker, { loaded: loaded({ [projectPath]: { allow: ["TOKEN"], deny: [] } }) }),
    ),
  ).resolves.toBeUndefined();
});

it("does not track deny-once denials", async () => {
  const tracker = createAuthorizationRetryTracker();
  const select = vi.fn(async () => "Deny once");
  await expect(
    authorizeOrPrompt(options(tracker, { context: { hasUI: true, mode: "tui", ui: { select } } })),
  ).rejects.toThrow("denied-once");
  expect(select).toHaveBeenCalledOnce();

  const secondSelect = vi.fn(async () => "Deny once");
  await expect(
    authorizeOrPrompt(
      options(tracker, { context: { hasUI: true, mode: "tui", ui: { select: secondSelect } } }),
    ),
  ).rejects.toThrow("denied-once");
  expect(secondSelect).toHaveBeenCalledOnce();
});

it("does not track denials whose persistence failed", async () => {
  const tracker = createAuthorizationRetryTracker();
  const recordDecisions = vi.fn(async () => {
    throw new Error("disk full");
  });
  await expect(authorizeOrPrompt(options(tracker, { recordDecisions }))).rejects.toThrow("save");

  const secondSelect = vi.fn(async () => "Deny for this project");
  await expect(
    authorizeOrPrompt(
      options(tracker, {
        recordDecisions,
        context: { hasUI: true, mode: "tui", ui: { select: secondSelect } },
      }),
    ),
  ).rejects.toThrow("save");
  expect(secondSelect).toHaveBeenCalledOnce();
});
